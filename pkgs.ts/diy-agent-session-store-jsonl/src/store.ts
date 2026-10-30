// store.ts — 按大小切桶的 jsonl 会话存储（SessionStore 的实现）
//
// 写：只写最后一桶；写满 `maxBucketBytes` 才切（新建文件 + 重写 index.json）。
//     正常 append 不碰 index.json —— bytes 在内存累计，只有切桶才落 index。
// 读：`readFrom(seq)` 先查 index 定位 `toSeq > seq` 的桶，只读这些文件（不扫全量）。
// 恢复：
//   · index.json 损坏 / 缺失 → 扫 log-*.jsonl 重建
//   · 磁盘上多出的桶（崩溃在切桶中途）→ 重建补登记
//   · index 引用的桶文件没了（删了中间一桶）→ `store/missing-bucket`，不静默跳过
//   · seq 缺号 / 重号 → `store/gap`
//
// 单条消息超过 maxBucketBytes 允许独占一桶（不切、不丢）。

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMessage, type ChatMessage, type SessionStore } from '@diy-agent/session';
import { StoreError } from './errors.js';
import {
    DEFAULT_MAX_BUCKET_BYTES,
    type BucketIndex,
    type BucketRecord,
    type JsonlSessionStoreOptions,
} from './types.js';

/** 桶文件名：log-0001.jsonl（序号从 1 起，定长 4 位，超出自然加宽） */
const BUCKET_RE = /^log-(\d+)\.jsonl$/;
const INDEX_FILE = 'index.json';

/** 本包对外暴露的存储（SessionStore + 索引查询） */
export interface JsonlSessionStore extends SessionStore {
    readonly dir: string;
    readonly maxBucketBytes: number;
    /** 当前桶索引（副本；宿主展示 / 排障用） */
    index(): BucketIndex;
}

/**
 * 打开（或新建）一个会话目录。
 * 打开时会做一次对账：缺桶报错、多桶补登记、index 坏了就重建。
 */
export async function openJsonlSessionStore(options: JsonlSessionStoreOptions): Promise<JsonlSessionStore> {
    if (typeof options !== 'object' || options === null) {
        throw new StoreError('store/invalid-options', 'openJsonlSessionStore 需要 { dir }', 'options');
    }
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
        throw new StoreError('store/invalid-options', 'dir 必须是非空字符串', 'dir');
    }
    const maxBucketBytes = options.maxBucketBytes ?? DEFAULT_MAX_BUCKET_BYTES;
    if (!Number.isInteger(maxBucketBytes) || maxBucketBytes <= 0) {
        throw new StoreError(
            'store/invalid-options',
            `maxBucketBytes 必须是正整数，拿到 ${String(maxBucketBytes)}`,
            'maxBucketBytes',
        );
    }

    const dir = options.dir;
    await mkdir(dir, { recursive: true });

    let records = await loadOrRebuild(dir);
    let totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
    let lastSeq = records.length === 0 ? 0 : records[records.length - 1].toSeq;

    // 对账后的 index 立刻落一次（补登记 / 刷新末桶 / 首次建目录都靠它）
    await writeIndex();

    const store: JsonlSessionStore = {
        dir,
        maxBucketBytes,
        index(): BucketIndex {
            return { buckets: records.map((record) => ({ ...record })), totalBytes, nextSeq: lastSeq + 1 };
        },
        async append(messages: readonly ChatMessage[]): Promise<void> {
            if (messages.length === 0) return;
            // 先全量校验再写：半批落盘比不落更糟（水位会认为收到了）
            let expected = lastSeq;
            const lines: string[] = [];
            for (const message of messages) {
                if (message.seq === undefined) {
                    throw new StoreError('store/message-without-seq', 'append 的消息必须带 seq（core 会分配）', 'seq');
                }
                if (!Number.isInteger(message.seq) || message.seq <= 0) {
                    throw new StoreError(
                        'store/invalid-options',
                        `seq 必须是正整数，拿到 ${String(message.seq)}`,
                        'seq',
                    );
                }
                if (message.seq !== expected + 1) {
                    throw new StoreError(
                        'store/gap',
                        `append 的 seq 必须连续：期望 ${expected + 1}，拿到 ${message.seq}`,
                        'seq',
                    );
                }
                expected = message.seq;
                lines.push(`${JSON.stringify(serialize(message))}\n`);
            }

            let rotated = false;
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                const message = messages[i];
                const bytes = Buffer.byteLength(line, 'utf8');
                let current = records[records.length - 1];
                if (!current) {
                    current = await createBucket();
                    rotated = true;
                } else if (current.bytes > 0 && current.bytes + bytes > maxBucketBytes) {
                    current = await createBucket();
                    rotated = true;
                }
                await appendFile(join(dir, current.file), line, 'utf8');
                records[records.length - 1] = {
                    ...current,
                    bytes: current.bytes + bytes,
                    toSeq: message.seq!,
                    fromAt: current.bytes === 0 ? (message.at ?? 0) : current.fromAt,
                    toAt: message.at ?? current.toAt,
                };
                totalBytes += bytes;
                lastSeq = message.seq!;
            }
            if (rotated) await writeIndex();
        },
        async readFrom(seq: number): Promise<ChatMessage[]> {
            if (!Number.isInteger(seq) || seq < 0) {
                throw new StoreError(
                    'store/invalid-options',
                    `readFrom(seq) 的 seq 必须是非负整数，拿到 ${String(seq)}`,
                    'seq',
                );
            }
            const candidates = records.filter((record) => record.toSeq > seq);
            if (candidates.length === 0) return [];

            const out: ChatMessage[] = [];
            let expected: number | undefined;
            for (const record of candidates) {
                const text = await readFile(join(dir, record.file), 'utf8');
                for (const [index, line] of text.split('\n').entries()) {
                    if (line.trim() === '') continue;
                    const message = parseLine(line, `${record.file}:${index + 1}`);
                    if (message.seq === undefined || message.seq <= seq) continue;
                    if (expected !== undefined && message.seq !== expected + 1) {
                        throw new StoreError(
                            'store/gap',
                            `读出的 seq 不连续：期望 ${expected + 1}，拿到 ${message.seq}`,
                            record.file,
                        );
                    }
                    expected = message.seq;
                    out.push(message);
                }
            }
            return out;
        },
        async readRange(range: { readonly from: number; readonly to: number }): Promise<ChatMessage[]> {
            if (
                typeof range !== 'object' ||
                range === null ||
                !Number.isFinite(range.from) ||
                !Number.isFinite(range.to) ||
                range.from > range.to
            ) {
                throw new StoreError(
                    'store/invalid-options',
                    'readRange({from,to}) 需要 from ≤ to 的有限毫秒数',
                    'range',
                );
            }
            // 桶的 fromAt/toAt 单调 ⇒ 二分找第一个可能相交的桶，再往后取到不相交为止
            const start = firstBucketEndingAtOrAfter(records, range.from);
            const out: ChatMessage[] = [];
            for (let index = start; index < records.length; index += 1) {
                const record = records[index];
                if (record.fromAt > range.to) break;
                const text = await readFile(join(dir, record.file), 'utf8');
                for (const [lineIndex, line] of text.split('\n').entries()) {
                    if (line.trim() === '') continue;
                    const message = parseLine(line, `${record.file}:${lineIndex + 1}`);
                    const at = message.at ?? 0;
                    if (at < range.from || at > range.to) continue;
                    out.push(message);
                }
            }
            return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
        },
        latestSeq(): number {
            return lastSeq;
        },
    };
    return store;

    // ── 内部实现 ────────────────────────────────────────────────

    async function createBucket(): Promise<BucketRecord> {
        // 以磁盘上最大编号 +1 命名：崩溃留下的空桶 / 手工补档都不会撞名
        const existing = await listBucketFiles(dir);
        const maxNumber = existing.reduce((max, name) => {
            const match = BUCKET_RE.exec(name);
            return match ? Math.max(max, Number(match[1])) : max;
        }, 0);
        const file = `log-${String(maxNumber + 1).padStart(4, '0')}.jsonl`;
        await writeFile(join(dir, file), '', 'utf8');
        const record: BucketRecord = { file, bytes: 0, fromSeq: lastSeq + 1, toSeq: lastSeq, fromAt: 0, toAt: 0 };
        records = [...records, record];
        return record;
    }

    async function writeIndex(): Promise<void> {
        const index: BucketIndex = {
            buckets: records.map((record) => ({ ...record })),
            totalBytes,
            nextSeq: lastSeq + 1,
        };
        const target = join(dir, INDEX_FILE);
        const temp = `${target}.tmp`;
        await writeFile(temp, `${JSON.stringify(index, null, 4)}\n`, 'utf8');
        await rename(temp, target);
    }
}

// ── 索引加载 / 重建 ──────────────────────────────────────────────

async function loadOrRebuild(dir: string): Promise<BucketRecord[]> {
    const files = await listBucketFiles(dir);
    const indexFile = join(dir, INDEX_FILE);
    let stored: BucketIndex | undefined;
    try {
        stored = JSON.parse(await readFile(indexFile, 'utf8')) as BucketIndex;
    } catch {
        stored = undefined;
    }

    if (stored === undefined || !Array.isArray(stored.buckets)) {
        // index 缺失 / 损坏：扫目录重建
        return rebuild(dir, files);
    }

    const onDisk = new Set(files);
    const missing = stored.buckets.filter((record) => !onDisk.has(record.file));
    if (missing.length > 0) {
        throw new StoreError(
            'store/missing-bucket',
            `index.json 引用的桶文件不存在：${missing.map((record) => record.file).join(', ')}`,
            dir,
        );
    }
    const known = new Set(stored.buckets.map((record) => record.file));
    const extra = files.filter((file) => !known.has(file));
    if (extra.length > 0) {
        // 崩溃在切桶中途：磁盘上多出桶 ⇒ 以磁盘为准整体重建
        return rebuild(dir, files);
    }

    // 末桶可能在 index 写入后又追加过：重扫末桶刷新 bytes / toSeq / toAt
    const records = stored.buckets.map((record) => ({ ...record }));
    if (records.length > 0) {
        const last = records[records.length - 1];
        const scanned = await scanBucket(dir, last.file);
        if (scanned !== undefined) records[records.length - 1] = scanned;
    }
    return records;
}

async function rebuild(dir: string, files: readonly string[]): Promise<BucketRecord[]> {
    const records: BucketRecord[] = [];
    let expected: number | undefined;
    for (const file of files) {
        const record = await scanBucket(dir, file);
        if (record === undefined) continue; // 空桶（崩溃留下的零字节文件）跳过
        if (expected !== undefined && record.fromSeq !== expected + 1) {
            throw new StoreError(
                'store/gap',
                `桶 ${file} 的 fromSeq=${record.fromSeq}，上一桶止于 ${expected}（缺号或重号）`,
                dir,
            );
        }
        expected = record.toSeq;
        records.push(record);
    }
    return records;
}

/** 扫一个桶：校验每行形状与 seq 连续，返回索引条目（空桶返回 undefined） */
async function scanBucket(dir: string, file: string): Promise<BucketRecord | undefined> {
    const text = await readFile(join(dir, file), 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    let fromSeq: number | undefined;
    let toSeq: number | undefined;
    let fromAt = 0;
    let toAt = 0;
    let expected: number | undefined;
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trim() === '') continue;
        const message = parseLine(line, `${file}:${index + 1}`);
        const seq = message.seq!;
        if (expected !== undefined && seq !== expected + 1) {
            throw new StoreError(
                'store/gap',
                `桶内 seq 不连续：期望 ${expected + 1}，拿到 ${seq}`,
                `${file}:${index + 1}`,
            );
        }
        expected = seq;
        if (fromSeq === undefined) {
            fromSeq = seq;
            fromAt = message.at ?? 0;
        }
        toSeq = seq;
        toAt = message.at ?? toAt;
    }
    if (fromSeq === undefined || toSeq === undefined) return undefined;
    return { file, bytes, fromSeq, toSeq, fromAt, toAt };
}

/** 二分：第一个 `toAt >= at` 的桶下标（没有 = 桶数） */
function firstBucketEndingAtOrAfter(records: readonly BucketRecord[], at: number): number {
    let low = 0;
    let high = records.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (records[mid].toAt >= at) high = mid;
        else low = mid + 1;
    }
    return low;
}

function parseLine(line: string, where: string): ChatMessage {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        throw new StoreError('store/corrupt', '不是合法 JSON', where);
    }
    try {
        return parseMessage(raw, 'message');
    } catch (error) {
        throw new StoreError('store/corrupt', error instanceof Error ? error.message : String(error), where);
    }
}

async function listBucketFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && BUCKET_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}

/** 落盘只用已知字段（不把内存里的多余属性带进文件） */
function serialize(message: ChatMessage): Record<string, unknown> {
    return {
        seq: message.seq,
        role: message.role,
        ...(message.type === undefined ? {} : { type: message.type }),
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.data === undefined ? {} : { data: message.data }),
        ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
        ...(message.at === undefined ? {} : { at: message.at }),
    };
}

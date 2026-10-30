// tests/intent.store.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 分桶 jsonl 存储「意图测试」—— 需求级（对应 ##456「存储分桶」判据）
//
//   T1  按大小切桶（不按日期）：写 40 MB 后 ≥3 个桶，每桶 ≤ maxBucketBytes
//   T2  seq 全局单调、跨桶连续：readFrom(seq) 跨桶拼接无损（前后 seq 连续）
//   T3  readFrom 只读需要的桶（不扫全量）：前面的桶被删也不会影响只读尾部
//   T4  删中间桶 ⇒ open 报 `store/missing-bucket`（不静默丢数据）
//   T5  index 坏了 / 丢了 ⇒ 扫目录重建；重建时发现缺号 ⇒ `store/gap`
//   T6  追加语义：seq 不连续 / 缺 seq 一律拒绝（半批落盘比不落更糟）
//   T7  重开后续写：lastSeq 不重号（末桶刷新）
//   T8  按时间查：readRange({from,to}) 只打开时间相交的桶（桶的 fromAt/toAt 可二分）
//   T9  桶文件名 = <序号>-<本地日期>-<本地时间><偏移>.jsonl（##464）
//       · 形如 0001-20261030-115000+0800.jsonl：时间取首条 at（不是 Date.now()），偏移取那一刻
//       · 同一秒切两个桶 ⇒ 序号递增、不重名
//       · index 丢失重建：以桶内数据为准，文件名只当提示
//
// 真文件系统（临时目录），不 mock fs —— 这层要验的就是落盘行为本身。
// ═══════════════════════════════════════════════════════════════

import { mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@diy-agent/session';
import { StoreError, openJsonlSessionStore } from '../src/index.js';

let dir: string;

beforeEach(async () => {
    clock = 0;
    dir = await mkdtemp(join(tmpdir(), 'diy-session-store-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 29, 0, 0, 0);
let clock = 0;

/** 一条消息（带 seq；内容可控大小） */
function message(seq: number, content: string): ChatMessage {
    clock += 1;
    return { seq, role: 'user', type: 'human', text: content, at: T0 + clock * 1000 };
}

/** 桶文件名（新命名 `<序号>-<日期>T<时间><+HHMM>.jsonl`；旧命名 `log-<序号>.jsonl` 读侧仍认） */
const BUCKET_NAME_RE = /^(?:\d{4,}-\d{8}-\d{6}[+-]\d{4}|log-\d+)\.jsonl$/;
const NEW_BUCKET_NAME_RE = /^\d{4,}-\d{8}-\d{6}[+-]\d{4}\.jsonl$/;

async function bucketFiles(target = dir): Promise<string[]> {
    // 按**序号**排序（不是字典序：旧命名 log-0001.jsonl 与新命名混放时字典序会排乱）
    const number = (name: string): number => Number(/^(?:log-)?(\d+)/.exec(name)?.[1] ?? '0');
    return (await readdir(target))
        .filter((name) => BUCKET_NAME_RE.test(name))
        .sort((left, right) => {
            const a = number(left);
            const b = number(right);
            return a === b ? left.localeCompare(right) : a - b;
        });
}

/** 毫秒 → `YYYYMMDD-HHMMSS+HHMM`（本地时刻 + 那一刻的偏移；独立算期望文件名用） */
function localStamp(at: number): string {
    const date = new Date(at);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    const ymd = `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const offset = date.getTimezoneOffset();
    const sign = offset > 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return `${ymd}-${hms}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** 第 n 个桶的文件名（序号定长 4 位） */
function bucketName(n: number, at: number): string {
    return `${String(n).padStart(4, '0')}-${localStamp(at)}.jsonl`;
}

describe('T1 按大小切桶', () => {
    it('写 40 MB 后 ≥3 个桶，每个 ≤ 16 MB（缺省上界）', async () => {
        const store = await openJsonlSessionStore({ dir });
        const chunk = 'x'.repeat(1024 * 1024); // 1 MB
        for (let seq = 1; seq <= 40; seq += 1) {
            await store.append([message(seq, `${String(seq).padStart(2, '0')}${chunk}`)]);
        }

        const files = await bucketFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);
        for (const file of files) {
            const { size } = await stat(join(dir, file));
            expect(size).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
        expect(store.latestSeq()).toBe(40);
    });

    it('按大小不按日期：同一毫秒的一堆消息也会切桶', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 512 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, 'y'.repeat(200))]);
        }
        expect((await bucketFiles()).length).toBeGreaterThan(1);
    });
});

describe('T2 跨桶读无损', () => {
    it('readFrom(0) 拿回全部；readFrom(k) 只拿 seq > k（跨桶连续）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        expect((await bucketFiles()).length).toBeGreaterThan(1);

        const all = await store.readFrom(0);
        expect(all.map((item) => item.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

        const tail = await store.readFrom(17);
        expect(tail.map((item) => item.seq)).toEqual([18, 19, 20]);

        // 重开（走 index.json）再读一次：结果一致
        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect((await reopened.readFrom(0)).map((item) => item.seq)).toEqual(all.map((item) => item.seq));
        expect(reopened.latestSeq()).toBe(20);
    });
});

describe('T3 readFrom 只读需要的桶', () => {
    it('删掉更早的桶后，只读尾部仍然成功（不是全量扫）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        // 删掉第一桶，并把它从 index 摘掉（模拟「很久以前的历史已归档」）
        await unlink(join(dir, files[0]));
        const index = store.index();
        const trimmed = { ...index, buckets: index.buckets.slice(1) };
        await writeIndexFile(join(dir, 'index.json'), trimmed);

        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        const tail = await reopened.readFrom(18);
        expect(tail.map((item) => item.seq)).toEqual([19, 20]);
    });
});

describe('T4 删中间桶要报缺失', () => {
    it('open 报 store/missing-bucket（不静默跳过）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);
        await unlink(join(dir, files[1]));

        await expect(openJsonlSessionStore({ dir, maxBucketBytes: 400 })).rejects.toMatchObject({
            code: 'store/missing-bucket',
        });
    });
});

describe('T5 index 坏了 / 丢了就重建', () => {
    it('删掉 index.json：扫目录重建，seq 仍然连续', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        await unlink(join(dir, 'index.json'));

        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(reopened.latestSeq()).toBe(12);
        expect((await reopened.readFrom(0)).map((item) => item.seq)).toEqual(
            Array.from({ length: 12 }, (_, index) => index + 1),
        );
    });

    it('删中间桶且 index 也没了 ⇒ 重建时发现缺号（store/gap）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        await unlink(join(dir, files[1]));
        await unlink(join(dir, 'index.json'));

        await expect(openJsonlSessionStore({ dir, maxBucketBytes: 400 })).rejects.toMatchObject({ code: 'store/gap' });
    });
});

describe('T6 追加语义', () => {
    it('缺 seq ⇒ store/message-without-seq；seq 不连续 ⇒ store/gap（先校验再写）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        await store.append([message(1, '一')]);

        const noSeq: ChatMessage = { role: 'user', text: '没有 seq' };
        await expect(store.append([noSeq])).rejects.toMatchObject({ code: 'store/message-without-seq' });

        await expect(store.append([message(3, '跳号')])).rejects.toMatchObject({ code: 'store/gap' });

        // 失败的追加没写进去
        expect(store.latestSeq()).toBe(1);
        expect((await store.readFrom(0)).map((item) => item.seq)).toEqual([1]);
    });

    it('一批消息中途造成的半批也不落盘（先全量校验）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        await expect(store.append([message(1, '一'), message(3, '三')])).rejects.toBeInstanceOf(StoreError);
        expect(store.latestSeq()).toBe(0);
        expect(await store.readFrom(0)).toEqual([]);
    });
});

describe('T8 按时间读', () => {
    it('readRange 只返回时间相交的消息（跨桶按 at 排序）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        // 每条相隔 1 秒（见 message()）；取第 5~9 秒
        const range = await store.readRange({ from: T0 + 5 * 1000, to: T0 + 9 * 1000 });
        expect(range.map((item) => item.seq)).toEqual([5, 6, 7, 8, 9]);
        expect(range.map((item) => item.at)).toEqual([
            T0 + 5 * 1000,
            T0 + 6 * 1000,
            T0 + 7 * 1000,
            T0 + 8 * 1000,
            T0 + 9 * 1000,
        ]);

        // 空区间 / 越界
        expect(await store.readRange({ from: T0 - 10000, to: T0 - 1 })).toEqual([]);
        await expect(store.readRange({ from: 5, to: 1 })).rejects.toMatchObject({ code: 'store/invalid-options' });
    });
});

describe('T7 重开后续写', () => {
    it('lastSeq 从末桶恢复，不重号', async () => {
        const first = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 6; seq += 1) {
            await first.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }

        const second = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(second.latestSeq()).toBe(6);
        await second.append([message(7, '继续'.padEnd(100, '。'))]);
        expect(second.latestSeq()).toBe(7);
        expect((await second.readFrom(6)).map((item) => item.seq)).toEqual([7]);
    });
});

describe('T9 桶文件名 = <序号>-<本地日期>-<时间><偏移>.jsonl（##464）', () => {
    it('文件名形如 0001-20261030-115000+0800.jsonl；时间取桶内首条 entry 的 at（不是「现在」）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        expect(files.length).toBeGreaterThan(1);
        for (const file of files) expect(file).toMatch(NEW_BUCKET_NAME_RE);

        // 首桶 = 第 1 条消息的 at（T0 + 1000），不是 Date.now()
        expect(files[0]).toBe(bucketName(1, T0 + 1000));

        // 每个桶的文件名 = 序号 + 桶内首条消息的 at 的本地时刻 / 偏移（与 index 的 fromAt 一致）
        const buckets = store.index().buckets;
        expect(buckets.map((bucket) => bucket.file)).toEqual(files);
        for (const [index, bucket] of buckets.entries()) {
            expect(bucket.file).toBe(bucketName(index + 1, bucket.fromAt));
        }
    });

    it('同一秒切两个桶 ⇒ 序号递增、文件不重名', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 120 });
        for (let seq = 1; seq <= 6; seq += 1) {
            // 所有 entry 同一毫秒（同一秒），每条独立成桶
            await store.append([{ seq, role: 'user', type: 'human', text: 'x'.repeat(60), at: T0 }]);
        }
        const files = await bucketFiles();
        expect(files.length).toBeGreaterThan(1);
        expect(new Set(files).size).toBe(files.length);
        expect(files).toEqual(files.map((_, index) => bucketName(index + 1, T0)));
        // 序号在前 ⇒ 字典序 = 序号序（不靠时间）
        expect(files).toEqual([...files].sort());
        expect(store.latestSeq()).toBe(6);
        expect((await store.readFrom(0)).map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('时间取首条 entry 的 at：at=0 ⇒ 1970 年（不是 Date.now()），偏移取那一刻', async () => {
        const store = await openJsonlSessionStore({ dir });
        await store.append([{ seq: 1, role: 'user', type: 'human', text: '零', at: 0 }]);
        const files = await bucketFiles();
        expect(files).toEqual([bucketName(1, 0)]);
        // TZ 无关：日期部分必是 1970 年的某天（东八区是 19700101-080000+0800），绝不是今年
        expect(files[0]).toMatch(/^0001-1970\d{4}-\d{6}[+-]\d{4}\.jsonl$/);
    });

    it('index 丢失后重建：以桶内数据为准，文件名只当提示（不改名、不报错）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        const realFirstAt = store.index().buckets[0].fromAt;
        // 把首桶改成错误的时间（1970），桶内数据不变 ⇒ 重建后仍以数据为准
        const wrong = '0001-19700101-000000+0000.jsonl';
        await rename(join(dir, files[0]), join(dir, wrong));
        await unlink(join(dir, 'index.json'));

        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(reopened.index().buckets[0].file).toBe(wrong); // 不改名
        expect(reopened.index().buckets[0].fromAt).toBe(realFirstAt); // 时间来自桶内首行
        expect(reopened.latestSeq()).toBe(12);
        expect((await reopened.readFrom(0)).map((item) => item.seq)).toEqual(
            Array.from({ length: 12 }, (_, index) => index + 1),
        );
    });

    it('旧命名 log-0001.jsonl 与新命名混放：按序号排序（字典序会把新旧排乱）', async () => {
        const { writeFile } = await import('node:fs/promises');
        const at = T0;
        await writeFile(join(dir, 'log-0001.jsonl'), `${JSON.stringify({ seq: 1, role: 'user', text: '旧', at })}\n`);
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(store.latestSeq()).toBe(1);
        await store.append([message(2, '新'.padEnd(100, '。'))]);
        const files = await bucketFiles();
        expect(files[0]).toBe('log-0001.jsonl');
        expect(files[1]).toBe(bucketName(2, T0 + 1000));
        expect((await store.readFrom(0)).map((item) => item.seq)).toEqual([1, 2]);
    });
});

/** 测试里直接改 index.json（模拟外部归档 / 手工修复） */
async function writeIndexFile(path: string, value: unknown): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

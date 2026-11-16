// store-jsonl.ts — `ActorStore` 的第一个落盘实现：**一行 = 一次提交**。
//
// 为什么不是「journal.jsonl + state.json 两个文件」：那样 append 与 save 之间崩一次，
// 就会出现「事件落了、状态没落」（`$events` 说发生过，查询说没发生）。
// 这里把「状态 + 游标 + 这次提交产生的事件」写成同一行 —— 一次 `appendFile` 就是一次提交，
// 崩在中间只会留下**半行**，读的时候丢掉半行即可（状态回到上一次提交，前后自洽）。
//
// 顺序（runtime 保证）：`append(events)` → `save({state, cursor})`。
// 于是 append 只进内存缓冲，**save 才是提交点**；没 save 过的 append 对读者不存在。
//
// 判据：`kill -9` 之后再起，`snapshot()` 要么是上一行的状态，要么是这一行的状态，不会是拼出来的。

import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';

import {
    type ActorStore,
    type Cursor,
    type JournalEntry,
    type NewEntry,
    type ReadOptions,
    type Snapshot,
} from '../../src/index.js';

/** 一行提交 */
interface Commit {
    readonly cursor: Cursor;
    readonly state: unknown;
    readonly entries: readonly JournalEntry[];
}

export interface JsonlStoreOptions {
    readonly dir: string;
    /** 崩在中间时留下的半行会走这里（诊断用，不影响读） */
    readonly onWarn?: (message: string) => void;
}

export interface JsonlStore<S> extends ActorStore<S> {
    /** 提交日志文件（诊断 / 演示里打印路径用） */
    readonly file: string;
    /** 已提交的提交条数（= 提交日志行数） */
    readonly commits: number;
    close(): Promise<void>;
}

const FILE = 'commits.jsonl';

export async function openJsonlStore<S>(opts: JsonlStoreOptions): Promise<JsonlStore<S>> {
    await mkdir(opts.dir, { recursive: true });
    const file = path.join(opts.dir, FILE);

    const raw = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return '';
        throw err;
    });

    // 尾部半行 = 崩在写的中途。**必须截掉**：不截的话下一次 append 会接在它后面，
    // 把「半行 + 新提交」拼成一行非法 JSON —— 一条坏尾巴会吃掉后来所有的提交。
    const tailStart = raw.lastIndexOf('\n') + 1;
    const tail = raw.slice(tailStart);
    if (tail.trim() !== '') {
        await truncate(file, Buffer.byteLength(raw.slice(0, tailStart), 'utf8'));
        opts.onWarn?.(`尾部半行（崩在写的中途，没提交过）已截掉：${tail.slice(0, 80)}`);
    }
    const complete = raw.slice(0, tailStart);

    let counter = 0;
    let commits = 0;
    let last: Commit | null = null;
    const history: JournalEntry[] = [];

    for (const line of complete.split('\n')) {
        if (line.trim() === '') continue;
        const commit = parseCommit(line, opts.onWarn);
        if (!commit) continue; // 半行：崩在写的中途 ⇒ 这一行没提交过
        commits += 1;
        last = commit;
        for (const entry of commit.entries) history.push(entry);
        counter = Math.max(counter, seqNumber(commit.cursor));
    }

    /** 还没 save 的 append（= 没提交，读者看不见） */
    let pending: JournalEntry[] = [];
    /** 提交串行化：两次 appendFile 不许交叉 */
    let writing: Promise<void> = Promise.resolve();

    const store: JsonlStore<S> = {
        file,
        get commits() {
            return commits;
        },
        async load(): Promise<Snapshot<S> | null> {
            if (!last) return null;
            return { state: last.state as S, cursor: last.cursor };
        },
        async save(snapshot: Snapshot<S>): Promise<void> {
            const entries = pending;
            pending = [];
            const commit: Commit = { cursor: snapshot.cursor, state: snapshot.state, entries };
            const line = JSON.stringify(commit);
            writing = writing.then(async () => {
                // 不需要 temp + rename：append 是「把这段字节接到尾」，
                // 崩只会留下不完整的一行，而读的时候半行会被丢掉（见 parseCommit）。
                await appendFile(file, `${line}\n`, 'utf8');
                commits += 1;
                last = commit;
                for (const entry of entries) history.push(entry);
            });
            await writing;
        },
        async append(incoming: readonly NewEntry[]): Promise<JournalEntry[]> {
            const appended = incoming.map((entry) => {
                counter += 1;
                return { ...entry, seq: `e${counter}` as Cursor };
            });
            pending.push(...appended);
            return appended;
        },
        async read(after: Cursor, readOpts?: ReadOptions): Promise<JournalEntry[]> {
            await writing;
            const include = readOpts?.include?.length ? new Set(readOpts.include) : null;
            const out: JournalEntry[] = [];
            for (const entry of history) {
                if (seqNumber(entry.seq) <= seqNumber(after)) continue;
                if (include && !include.has(entry.name)) continue;
                out.push(entry);
                if (readOpts?.limit && out.length >= readOpts.limit) break;
            }
            return out;
        },
        caughtUp(): boolean {
            return true;
        },
        async close(): Promise<void> {
            await writing;
        },
    };

    return store;
}

function parseCommit(line: string, onWarn?: (message: string) => void): Commit | null {
    try {
        const value = JSON.parse(line) as Partial<Commit>;
        if (typeof value.cursor !== 'string' || !Array.isArray(value.entries) || value.state === undefined) {
            onWarn?.(`提交行结构不符，已丢弃：${line.slice(0, 120)}`);
            return null;
        }
        return {
            cursor: value.cursor as Cursor,
            state: value.state,
            entries: value.entries as JournalEntry[],
        };
    } catch {
        // 中间行坏掉（不是尾巴）：跳过它，但不截断 —— 后面的提交还是好的
        onWarn?.(`提交行不是合法 JSON，已丢弃：${line.slice(0, 120)}`);
        return null;
    }
}

function seqNumber(cursor: Cursor | string): number {
    const n = Number.parseInt(String(cursor).slice(1), 10);
    return Number.isNaN(n) ? 0 : n;
}

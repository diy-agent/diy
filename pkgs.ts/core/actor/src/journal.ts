// journal.ts — 事件日志 + 快照的**存储接口**，外加一个内存实现（零 IO，测试与单进程直接用）。
//
// 为什么把「日志」和「快照」放在一个接口里：它们必须**一起**提交。
// 一次成功命令的收尾是「append(事件) → save(快照 + 游标)」，两步的顺序不能反
// （先落快照后追加事件 ⇒ 崩在中间会丢事件）。真实实现（jsonl / sqlite）把两步塞进同一个事务。
//
// 游标（`Cursor`）由 store 分配，runtime 只搬运。约定见 wire.ts `compareCursor`：
// 内置实现用 `e<十进制>`；接别的 store 要保证同前缀 + 单调，否则自己实现比较并注入。

import type { CommandId, Cursor } from './wire.js';
import { CURSOR_ZERO } from './wire.js';

/** 一条已落盘的事件 */
export interface JournalEntry {
    readonly seq: Cursor;
    readonly name: string;
    /** 毫秒时间戳（`at` 的位置点语义见 docs/07-naming-ledger.md B2） */
    readonly at: number;
    readonly data: unknown;
    /** 由哪个命令产生（`$command.finished` 靠它关联） */
    readonly commandId?: CommandId;
}

/** 待追加的事件（seq 由 store 分配） */
export interface NewEntry {
    readonly name: string;
    readonly at: number;
    readonly data: unknown;
    readonly commandId?: CommandId;
}

/** 快照：状态 + 它物化到的位置。两者必须同时成立，否则恢复会重放/跳过事件 */
export interface Snapshot<S> {
    readonly state: S;
    readonly cursor: Cursor;
}

export interface ReadOptions {
    /** 只读这些事件名（空/缺省 = 全部） */
    readonly include?: readonly string[];
    readonly limit?: number;
}

/**
 * actor 的持久化接口。**没有 `delete`、没有 `update`** —— 事件日志只追加，
 * 这是 `watch({ after })` 能补历史和「重开页面看到同一份答案」的前提。
 */
export interface ActorStore<S> {
    load(): Promise<Snapshot<S> | null>;
    save(snapshot: Snapshot<S>): Promise<void>;
    append(entries: readonly NewEntry[]): Promise<JournalEntry[]>;
    read(after: Cursor, opts?: ReadOptions): Promise<JournalEntry[]>;
    /**
     * 是否已追到 `watermark`。只给 `consistency: "owner"` 用：
     * 单机/单事件源恒 true；接远端投影时才有意义（见 docs/02-wire.md `consistency`）。
     */
    caughtUp?(watermark: Cursor): boolean;
}

/** 内存实现：数组 + 计数器。断电即失，够单进程与测试用 */
export function createMemoryStore<S>(
    init: { state: S; entries?: readonly JournalEntry[] } | null = null,
): ActorStore<S> {
    let snapshot: Snapshot<S> | null = init ? { state: init.state, cursor: CURSOR_ZERO } : null;
    const entries: JournalEntry[] = [];
    let counter = 0;

    return {
        async load() {
            return snapshot;
        },
        async save(next) {
            snapshot = next;
        },
        async append(incoming) {
            const appended = incoming.map((e) => {
                counter += 1;
                return { ...e, seq: `e${counter}` as Cursor };
            });
            entries.push(...appended);
            return appended;
        },
        async read(after, opts) {
            const include = opts?.include?.length ? new Set(opts.include) : null;
            const out: JournalEntry[] = [];
            for (const e of entries) {
                if (compareSeq(e.seq, after) <= 0) continue;
                if (include && !include.has(e.name)) continue;
                out.push(e);
                if (opts?.limit && out.length >= opts.limit) break;
            }
            return out;
        },
        caughtUp() {
            return true;
        },
    };
}

/** 与 wire.ts `compareCursor` 同口径（store 内部用，避免循环依赖） */
function compareSeq(a: Cursor, b: Cursor): number {
    const na = Number.parseInt(a.slice(1), 10);
    const nb = Number.parseInt(b.slice(1), 10);
    return na - nb;
}

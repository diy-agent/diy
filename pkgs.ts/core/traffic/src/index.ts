// traffic —— 出站流量的**单一实现**：内存环形缓冲 + 订阅 + 可选落盘。
//
// ── 为什么统一（2026-11-10 用户定）──
//   「内存实现和文件是否可统一为一个实现，可以开关存储以达到写入目的？未开启则限定一定数量
//    写入的先进先出队列，还可以外部订阅？」
//   内存与文件不是两种实现，是**同一份数据的两个去路**。`persist` 是唯一开关。
//
// ── 三层，谁是开关 ──
//   ① 环形缓冲（`recent`）   永远开 —— agent 查「我刚发的那步是什么」靠它，µs 级
//   ② 订阅（`subscribe`）    永远开 —— UI 状态栏 / `tail -f` / agent 自己，同一条流
//   ③ 落盘（`query`）        `persist` 开关 —— 跨天、重启后还要查才需要
//
// ── 三条硬约束 ──
//   · **双上限**：条数 500 为主、字节 8MB 兜底，任一超出就淘汰最旧的。
//     只按条数会在「几个 200KB 的大请求」上把内存撑爆。
//   · **订阅者不许阻塞**：`push` 在请求热路径上，一个慢订阅者会拖慢每个请求。
//     慢处理自己放 microtask。
//   · **落盘失败不阻断**：内存那条留着，同时向订阅者推一条 `persist-error`。
//     日志是观测手段，不能让观测失败拖垮主流程（同 @diy-agent/bot 的工具错误口径）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一条流量记录（字段由调用方定，本包只保证 `kind` / `at` 存在） */
export interface TrafficEntry {
    readonly kind: string;
    /** 毫秒时间戳 */
    readonly at: number;
    readonly [key: string]: unknown;
}

export interface TrafficStoreOptions {
    /** 环形缓冲条数上限（缺省 500） */
    readonly bufferSize?: number;
    /** 环形缓冲字节上限（缺省 8MB）；按 `JSON.stringify` 后的长度估 */
    readonly maxBytes?: number;
    /** 是否落盘（缺省 false）；true 时 `dir` 必需 */
    readonly persist?: boolean;
    /** 落盘目录（`<dir>/<YYYY-MM-DD>.jsonl`，按天切） */
    readonly dir?: string;
    /** 注入时钟（测试用；缺省 `Date.now`） */
    readonly now?: () => number;
}

/** `recent` 的筛选条件 */
export interface RecentQuery {
    /** 取最近多少条（缺省全窗口） */
    readonly n?: number;
    /** 只看这些 kind（缺省不过滤） */
    readonly kind?: string | readonly string[];
    /** 只看某个任务的（缺省不过滤）；条目上 `taskUri` 为 null 的不算 */
    readonly taskUri?: string;
    /** 只看 `at >= 这个毫秒时间` 的 */
    readonly since?: number;
}

export interface TrafficStats {
    readonly count: number;
    readonly bytes: number;
    /** 因为窗口上限被挤掉的条数（累计） */
    readonly dropped: number;
    /** 落盘失败的次数（累计；内存里那条仍保留） */
    readonly persistErrors: number;
}

const DEFAULT_BUFFER_SIZE = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 一天的日志文件名（本地时区，与 diy-app 的 `log/network/<day>.jsonl` 同构） */
export function dayFileOf(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}

export class TrafficStore {
    private readonly ring: TrafficEntry[] = [];
    private readonly sizes: number[] = [];
    private bytes = 0;
    private dropped = 0;
    private persistErrors = 0;
    private readonly subs = new Set<(e: TrafficEntry) => void>();
    private readonly bufferSize: number;
    private readonly maxBytes: number;
    private readonly persist: boolean;
    private readonly dir: string | undefined;
    private readonly now: () => number;

    constructor(opts: TrafficStoreOptions = {}) {
        this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
        this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        this.persist = opts.persist ?? false;
        this.dir = opts.dir;
        this.now = opts.now ?? Date.now;
        if (this.persist && (this.dir === undefined || this.dir === '')) {
            throw new Error('traffic: persist=true 时必须给 dir', { cause: { code: 'traffic/no-dir' } });
        }
    }

    /**
     * 记一条。**永不抛** —— 落盘失败降级成一条 `persist-error` 推给订阅者。
     *
     * 调用方（provider 的 HTTP 层）在每次真发之后调它，不该被日志的失败影响。
     */
    push(entry: TrafficEntry): void {
        const e: TrafficEntry = entry.at === undefined ? { ...entry, at: this.now() } : entry;

        // ① 环形缓冲：条数与字节双上限
        const size = jsonBytes(e);
        this.ring.push(e);
        this.sizes.push(size);
        this.bytes += size;
        while (this.ring.length > this.bufferSize || (this.bytes > this.maxBytes && this.ring.length > 1)) {
            this.ring.shift();
            this.bytes -= this.sizes.shift() ?? 0;
            this.dropped += 1;
        }

        // ② 订阅：同步调用，订阅者自己保证不阻塞
        for (const cb of this.subs) {
            try {
                cb(e);
            } catch {
                // 订阅者抛错不能影响别的订阅者，更不能影响主流程
            }
        }

        // ③ 落盘（开关）
        if (this.persist) this.appendToFile(e);
    }

    /** 内存窗口里最近的一批（同步、µs 级）。返回的是**副本**，调用方改不到内部状态。 */
    recent(query: RecentQuery = {}): TrafficEntry[] {
        const kinds = query.kind === undefined ? null : new Set(typeof query.kind === 'string' ? [query.kind] : query.kind);
        const out: TrafficEntry[] = [];
        for (const e of this.ring) {
            if (kinds !== null && !kinds.has(e.kind)) continue;
            if (query.taskUri !== undefined && e['taskUri'] !== query.taskUri) continue;
            if (query.since !== undefined && e.at < query.since) continue;
            out.push(e);
        }
        return query.n === undefined ? out : out.slice(-query.n);
    }

    /**
     * 订阅新记录。返回取消函数。
     *
     * **同步调用**：`push` 里直接调 cb，所以 cb 必须立即返回 —— 要慢处理（写终端、
     * 发 HTTP）自己放 microtask / 队列里。
     */
    subscribe(cb: (e: TrafficEntry) => void): () => void {
        this.subs.add(cb);
        return () => {
            this.subs.delete(cb);
        };
    }

    /**
     * 文件兜底查询（超出内存窗口 / 跨天 / 重启后）。
     *
     * 只扫**当天**与之前的文件（按名字倒序），命中 `limit` 就停 —— 不加载全部分片。
     * `persist=false` 时返回空数组（没有文件可查）。
     */
    query(query: RecentQuery = {}): TrafficEntry[] {
        if (!this.persist || this.dir === undefined) return [];
        const limit = query.n ?? 200;
        const kinds = query.kind === undefined ? null : new Set(typeof query.kind === 'string' ? [query.kind] : query.kind);
        const out: TrafficEntry[] = [];

        let files: string[];
        try {
            files = readdirSync(this.dir)
                .filter((f) => f.endsWith('.jsonl'))
                .sort()
                .reverse();
        } catch {
            return [];
        }

        for (const file of files) {
            let lines: string[];
            try {
                lines = readFileSync(join(this.dir, file), 'utf-8').split('\n').filter((l) => l !== '');
            } catch {
                continue;
            }
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                let e: TrafficEntry;
                try {
                    e = JSON.parse(lines[i]!) as TrafficEntry;
                } catch {
                    continue;
                }
                if (kinds !== null && !kinds.has(e.kind)) continue;
                if (query.taskUri !== undefined && e['taskUri'] !== query.taskUri) continue;
                if (query.since !== undefined && e.at < query.since) continue;
                out.push(e);
                if (out.length >= limit) return out.reverse();
            }
        }
        return out.reverse();
    }

    /** 当前窗口的计数（给 UI 状态栏 / `traffic stats`） */
    stats(): TrafficStats {
        return {
            count: this.ring.length,
            bytes: this.bytes,
            dropped: this.dropped,
            persistErrors: this.persistErrors,
        };
    }

    /**
     * 落盘：一天的记录一个文件。
     *
     * 失败**不抛**，改为推一条 `persist-error` 给订阅者 —— 内存里那条已经在了，
     * 丢的只是「以后能不能从文件查到」，不该让请求失败。
     */
    private appendToFile(e: TrafficEntry): void {
        const dir = this.dir;
        if (dir === undefined) return;
        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, dayFileOf(e.at)), `${JSON.stringify(e)}\n`, 'utf-8');
        } catch (cause) {
            this.persistErrors += 1;
            const err: TrafficEntry = {
                kind: 'persist-error',
                at: this.now(),
                message: cause instanceof Error ? cause.message : String(cause),
                failedKind: e.kind,
            };
            for (const cb of this.subs) {
                try {
                    cb(err);
                } catch {
                    /* 同上：订阅者抛错不影响别人 */
                }
            }
        }
    }
}

/** `JSON.stringify` 的字节数（估算窗口占用；字符串用 UTF-8 长度，不是字符数） */
function jsonBytes(v: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
    } catch {
        return 0;
    }
}

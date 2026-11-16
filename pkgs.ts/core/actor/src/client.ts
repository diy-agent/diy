// client.ts — 调用方（typed facade）：`cmd` / `query` / `watch` 三个动词，别的都不给。
//
// 设计取守：
//   1. **不抛异常**。返回 `Outcome` 判别联合 —— 调用方必写失败分支，不会被一个 try/catch 兜掉。
//      要抛的地方只有一个：`expect()` 帮你把 `ok:false` 转成 `ActorError`。
//   2. **不自己造 targets**。多目标扇出是 actor 的声明（`fanoutQuery`），调用方看不到摆放。
//   3. **`commandId` 由调用方持有**。同一个 id 重发 = 幂等重试；新 id = 新命令。
//      这是「网络抖一下不会多写一条」的唯一来源（docs/04-runtime.md「幂等」）。

import { ActorError, type ActorCode } from './errors.js';
import type { CmdInput, CmdNames, CmdOutput, Kind, QueryInput, QueryNames, QueryOutput } from './kinds.js';
import type { Link } from './transport.js';
import {
    COMMAND_STATUS,
    CURSOR_ZERO,
    EVENTS,
    compareCursor,
    newCommandId,
    newRequestId,
    type CommandId,
    type Consistency,
    type Cursor,
    type EventFrame,
    type Frame,
    type Meta,
} from './wire.js';

export type QueryOutcome<T> =
    | { readonly ok: true; readonly data: T; readonly watermark: Cursor; readonly stale: boolean; readonly meta?: Meta }
    | { readonly ok: false; readonly code: ActorCode; readonly message: string; readonly retryable: boolean };

export type CmdOutcome<T> =
    | { readonly ok: true; readonly accepted: false; readonly data: T; readonly seq: Cursor }
    | { readonly ok: true; readonly accepted: true; readonly at: Cursor }
    | { readonly ok: false; readonly code: ActorCode; readonly message: string; readonly retryable: boolean };

export interface RequestOptions {
    readonly timeoutMs?: number;
}

export interface CmdOptions extends RequestOptions {
    /** 重试必须复用同一个（缺省每次生成新的） */
    readonly commandId?: CommandId;
}

export interface QueryOptions extends RequestOptions {
    /** 只能升不能降：actor 声明 projection 时，调用方可以要求 owner */
    readonly consistency?: Consistency;
}

export interface WatchOptions {
    /** 从哪个位置开始读（缺省从当前位置往前…不，缺省读全量）；补历史 + 追实时 */
    readonly after?: Cursor;
    /** 只收这些事件名（空/缺省 = 全部） */
    readonly include?: readonly string[];
    readonly signal?: AbortSignal;
}

export interface ClientOptions<K extends Kind> {
    readonly link: Link;
    readonly kind: K;
    /** 单请求缺省超时；慢查询（扫多台机器）由调用方按需调大 */
    readonly timeoutMs?: number;
}

interface Pending {
    resolve(frame: Frame): void;
    timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ActorClient<K extends Kind> {
    readonly kind: K;

    readonly #link: Link;
    readonly #timeoutMs: number;
    readonly #pending = new Map<string, Pending>();
    readonly #eventSinks = new Set<(event: EventFrame) => void>();

    constructor(opts: ClientOptions<K>) {
        this.kind = opts.kind;
        this.#link = opts.link;
        this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.#link.onFrame((frame) => this.#receive(frame));
    }

    /** 命令：写入路径。返回 `done` / `accepted`（长活） / 失败 */
    async cmd<N extends CmdNames<K>>(
        name: N,
        data: CmdInput<K, N>,
        opts: CmdOptions = {},
    ): Promise<CmdOutcome<CmdOutput<K, N>>> {
        const commandId = opts.commandId ?? newCommandId();
        const reply = await this.#request({ type: 'cmd', id: newRequestId(), commandId, name, data }, opts.timeoutMs);
        switch (reply.type) {
            case 'done':
                return { ok: true, accepted: false, data: reply.data as CmdOutput<K, N>, seq: reply.seq };
            case 'accepted':
                return { ok: true, accepted: true, at: reply.at };
            case 'rejected':
                return {
                    ok: false,
                    code: reply.code,
                    message: describe(reply.message, reply.issues),
                    retryable: false,
                };
            case 'err':
                return { ok: false, code: reply.code, message: reply.message, retryable: reply.retryable ?? false };
            default:
                return {
                    ok: false,
                    code: 'E_INTERNAL',
                    message: `命令收到了不该收到的回执：${reply.type}`,
                    retryable: false,
                };
        }
    }

    /** 查询：读路径。业务状态（含“这台机器没启动”）都在 `data` 里 */
    async query<N extends QueryNames<K>>(
        name: N,
        data: QueryInput<K, N>,
        opts: QueryOptions = {},
    ): Promise<QueryOutcome<QueryOutput<K, N>>> {
        return this.rawQuery(name, data, opts) as Promise<QueryOutcome<QueryOutput<K, N>>>;
    }

    /** 逃生口：`$` 保留查询（`$events` / `$command.status`）与跨包转发用 */
    async rawQuery(name: string, data: unknown, opts: QueryOptions = {}): Promise<QueryOutcome<unknown>> {
        const reply = await this.#request(
            { type: 'query', id: newRequestId(), name, data, consistency: opts.consistency },
            opts.timeoutMs,
        );
        switch (reply.type) {
            case 'ok':
                return {
                    ok: true,
                    data: reply.data,
                    watermark: reply.watermark,
                    stale: reply.stale ?? false,
                    meta: reply.meta,
                };
            case 'rejected':
                return {
                    ok: false,
                    code: reply.code,
                    message: describe(reply.message, reply.issues),
                    retryable: false,
                };
            case 'err':
                return { ok: false, code: reply.code, message: reply.message, retryable: reply.retryable ?? false };
            default:
                return {
                    ok: false,
                    code: 'E_INTERNAL',
                    message: `查询收到了不该收到的回执：${reply.type}`,
                    retryable: false,
                };
        }
    }

    /** 命令状态（重开页面 / 换设备的冷补，配合 `commandId`） */
    async commandStatus(commandId: CommandId): Promise<QueryOutcome<{ status: string }>> {
        return (await this.rawQuery(COMMAND_STATUS, { commandId })) as QueryOutcome<{ status: string }>;
    }

    /**
     * 事件流：先按 `after` 补历史，再接实时推。同一个 `seq` 只出一次。
     *
     * 注意：`break` 会让生成器停在等待态（JS 的 async generator 没有外部取消）。
     * 要能真中断就传 `signal`，或在 `watch` 外面用 `takeUntil` 之类的封装。
     */
    async *watch(opts: WatchOptions = {}): AsyncIterable<EventFrame> {
        const include = opts.include && opts.include.length > 0 ? new Set(opts.include) : null;
        const buffered: EventFrame[] = [];
        let wake: (() => void) | null = null;

        const sink = (event: EventFrame) => {
            buffered.push(event);
            wake?.();
        };
        this.#eventSinks.add(sink);

        try {
            const caught = await this.rawQuery(EVENTS, { after: opts.after ?? CURSOR_ZERO, include: opts.include });
            if (!caught.ok) throw new ActorError(caught.code, `读历史事件失败：${caught.message}`);
            const page = caught.data as {
                events: { seq: Cursor; name: string; at: number; data: unknown; commandId?: CommandId }[];
                cursor: Cursor;
            };
            const seen = new Set<string>();
            for (const entry of page.events) {
                seen.add(entry.seq);
                if (include && !include.has(entry.name)) continue;
                yield {
                    type: 'event',
                    name: entry.name,
                    data: entry.data,
                    seq: entry.seq,
                    at: entry.at,
                    commandId: entry.commandId,
                };
            }

            for (;;) {
                if (opts.signal?.aborted) return;
                while (buffered.length > 0) {
                    const event = buffered.shift()!;
                    if (seen.has(event.seq)) continue;
                    seen.add(event.seq);
                    if (compareCursor(event.seq, page.cursor) <= 0) continue; // 历史里已经有了
                    if (include && !include.has(event.name)) continue;
                    yield event;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    opts.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                wake = null;
            }
        } finally {
            this.#eventSinks.delete(sink);
        }
    }

    // ── 内部 ────────────────────────────────────────────────────────────────

    #request(frame: Frame, timeoutMs?: number): Promise<Frame> {
        const id = (frame as { id: string }).id;
        const promise = new Promise<Frame>((resolve) => {
            const pending: Pending = { resolve };
            const budget = timeoutMs ?? this.#timeoutMs;
            if (budget > 0) {
                pending.timer = setTimeout(() => {
                    this.#pending.delete(id);
                    resolve({
                        type: 'err',
                        id: id as never,
                        code: 'E_TIMEOUT',
                        message: `请求超时 ${budget}ms`,
                        retryable: true,
                    });
                }, budget);
            }
            this.#pending.set(id, pending);
        });
        this.#link.send(frame);
        return promise;
    }

    #receive(frame: Frame): void {
        if (frame.type === 'event') {
            for (const sink of this.#eventSinks) sink(frame);
            return;
        }
        if (!('id' in frame)) return;
        const pending = this.#pending.get(frame.id);
        if (!pending) return; // 迟到的回执（已超时）：丢弃，不误配到别的请求上
        this.#pending.delete(frame.id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(frame);
    }
}

/** 工厂：`createClient({ link, kind })` */
export function createClient<K extends Kind>(opts: ClientOptions<K>): ActorClient<K> {
    return new ActorClient(opts);
}

/** 把失败分支转成异常（只在你确实想 throw 的地方用） */
export function expect<T>(outcome: QueryOutcome<T> | CmdOutcome<T>): T {
    if (outcome.ok === false) throw new ActorError(outcome.code, outcome.message, { retryable: outcome.retryable });
    return 'data' in outcome ? (outcome.data as T) : (undefined as T);
}

function describe(message: string, issues?: { path: string; message: string }[]): string {
    if (!issues || issues.length === 0) return message;
    return `${message}：${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`;
}

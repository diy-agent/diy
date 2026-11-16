// runtime.ts — actor 本体：单写者队列 + 命令/查询派发 + 事件提交 + 幂等 + 扇出。
//
// 一条不变量撑起整个文件：**所有会碰状态的代码都在同一条串行队列上跑**。
// （Go 的「单协程 + channel」的 TS 等价物，见 docs/01-model.md。）
// 所以这里有零把锁、零原子操作：`#state` 只被队列里的工作单元读写。
//
// 一次成功命令的收尾是原子的三步：追加事件 → 落快照（含游标）→ 广播事件。
// 任何一步抛错就整批不认（回 `err`），不会出现「状态变了但事件没落」。

import { z } from 'zod';

import { ActorError, toActorError, type ActorCode } from './errors.js';
import { allFailed, runFanout, type FanoutPort, type PerTarget } from './fanout.js';
import type { CommandContext, CommandDef, CommandResult, EventRecord, Kind, QueryContext, QueryDef } from './kinds.js';
import { createMemoryStore, type ActorStore, type JournalEntry, type NewEntry } from './journal.js';
import type { Link } from './transport.js';
import {
    COMMAND_FINISHED,
    COMMAND_STATUS,
    CURSOR_ZERO,
    EVENTS,
    FAULT,
    type CommandId,
    type Cursor,
    type FanoutReceipt,
    type Frame,
    type Meta,
    type Target,
} from './wire.js';

// ── 幂等表 / 长活簿 ─────────────────────────────────────────────────────────

type IdempotencyRecord =
    | { readonly status: 'running' }
    | { readonly status: 'done'; readonly data: unknown; readonly seq: Cursor }
    | { readonly status: 'failed'; readonly code: ActorCode; readonly message: string; readonly retryable: boolean };

interface DeferredRecord {
    pending: number;
    /** 已承诺的收尾事件是否还能说 ok（任一后续单元失败 ⇒ false） */
    ok: boolean;
    code?: ActorCode;
    message?: string;
    output?: unknown;
    /** 是否真的排过后续单元 —— 排过才发 `$command.finished` */
    sawDefer: boolean;
}

/** runtime 自己服务的事件（`$` 前缀）的 schema；kind 的 `events` 只管业务事件 */
const RUNTIME_EVENT_SCHEMAS: Record<string, z.ZodType> = {
    [COMMAND_FINISHED]: z.object({
        commandId: z.string(),
        ok: z.boolean(),
        code: z.string().optional(),
        message: z.string().optional(),
        output: z.unknown().optional(),
    }),
    [FAULT]: z.object({ commandId: z.string(), code: z.string(), message: z.string() }),
};

const EVENTS_INPUT = z.object({
    after: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(1000).optional(),
});

const COMMAND_STATUS_INPUT = z.object({ commandId: z.string().min(1) });

// ── 选项 ────────────────────────────────────────────────────────────────────

export interface CreateActorOptions<K extends Kind> {
    readonly kind: K;
    /** actor 地址（如 `diy://node-a/task/t1`）；只用于日志和扇出回执对照 */
    readonly uri: string;
    /** 缺省内存 store（零 IO，测试够用；生产由调用方注入 jsonl / sqlite 实现） */
    readonly store?: ActorStore<z.output<K['state']>>;
    /** 扇出端口：有 `fanoutQuery` 才需要。不注入时扇出查询回 `err E_UNAVAILABLE` */
    readonly port?: FanoutPort;
    readonly now?: () => number;
    /** 扇出单项超时缺省值（毫秒） */
    readonly fanoutTimeoutMs?: number;
    readonly onLog?: (event: { level: 'warn' | 'error'; message: string; error?: unknown }) => void;
}

// ── actor 句柄 ──────────────────────────────────────────────────────────────

export interface ActorRuntime<K extends Kind> {
    readonly uri: string;
    readonly kind: K;
    /** 加载快照（没有就跑 `initial()` 并落一份）。**必须先 start 再 attach** */
    start(): Promise<this>;
    attach(link: Link): () => void;
    /** 当前状态 + 游标（测试 / 诊断用；业务一律走查询） */
    snapshot(): { state: z.output<K['state']>; cursor: Cursor };
    /** 排空队列后关闭 */
    close(): Promise<void>;
}

export class Actor<K extends Kind> implements ActorRuntime<K> {
    readonly uri: string;
    readonly kind: K;

    readonly #store: ActorStore<z.output<K['state']>>;
    readonly #port?: FanoutPort;
    readonly #now: () => number;
    readonly #fanoutTimeoutMs?: number;
    readonly #onLog: (event: { level: 'warn' | 'error'; message: string; error?: unknown }) => void;

    #state: z.output<K['state']>;
    #cursor: Cursor = CURSOR_ZERO;
    #started = false;
    #closed = false;

    readonly #links = new Set<Link>();
    readonly #idem = new Map<CommandId, IdempotencyRecord>();
    readonly #deferred = new Map<CommandId, DeferredRecord>();
    /** 串行队列的队尾：所有工作单元都挂在它后面 */
    #tail: Promise<unknown> = Promise.resolve();

    constructor(opts: CreateActorOptions<K>) {
        this.kind = opts.kind;
        this.uri = opts.uri;
        this.#store = opts.store ?? createMemoryStore<z.output<K['state']>>();
        this.#port = opts.port;
        this.#now = opts.now ?? (() => Date.now());
        this.#fanoutTimeoutMs = opts.fanoutTimeoutMs;
        this.#onLog = opts.onLog ?? (() => {});
        // 构造期先算一份（`start()` 会用快照覆盖）；不落盘，所以崩了也无副作用
        this.#state = this.kind.state.parse(this.kind.initial({ uri: this.uri, now: this.#now() })) as z.output<
            K['state']
        >;
    }

    async start(): Promise<this> {
        if (this.#started) return this;
        const snap = await this.#store.load();
        if (snap) {
            this.#state = snap.state;
            this.#cursor = snap.cursor;
        } else {
            await this.#store.save({ state: this.#state, cursor: this.#cursor });
        }
        this.#started = true;
        return this;
    }

    attach(link: Link): () => void {
        this.#links.add(link);
        const off = link.onFrame((frame) => this.#intake(frame, link));
        return () => {
            off();
            this.#links.delete(link);
        };
    }

    snapshot(): { state: z.output<K['state']>; cursor: Cursor } {
        return { state: this.#state, cursor: this.#cursor };
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#tail.catch(() => undefined);
        this.#links.clear();
    }

    // ── 入口：串行队列 ──────────────────────────────────────────────────────

    /**
     * 把所有工作单元挂在队尾。**读也排队**：读绕过队列就会读到「命令改了一半」的中间态，
     * 而这正是 actor 要消灭的东西（docs/01-model.md「为什么必须顺序」）。
     */
    #enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.#tail.then(fn, fn);
        this.#tail = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    #intake(frame: Frame, link: Link): void {
        if (this.#closed) return;
        if (frame.type === 'cmd') {
            void this.#enqueue(() => this.#handleCmd(frame, link)).catch((err) =>
                this.#onLog({ level: 'error', message: '命令处理崩了', error: err }),
            );
            return;
        }
        if (frame.type === 'query') {
            void this.#enqueue(() => this.#handleQuery(frame, link)).catch((err) =>
                this.#onLog({ level: 'error', message: '查询处理崩了', error: err }),
            );
            return;
        }
        // 出向帧打到 actor：协议违规（不是业务错）
        if ('id' in frame) {
            link.send({
                type: 'err',
                id: frame.id,
                code: 'E_INVALID_ARGUMENT',
                message: `actor 不接受 ${frame.type} 帧`,
            });
        }
    }

    // ── 命令 ────────────────────────────────────────────────────────────────

    async #handleCmd(frame: Extract<Frame, { type: 'cmd' }>, link: Link): Promise<void> {
        const def = this.kind.commands[frame.name] as CommandDef<z.output<K['state']>> | undefined;
        if (!def) {
            this.#reject(link, frame.id, frame.commandId, 'E_UNKNOWN_METHOD', `未声明命令：${frame.name}`);
            return;
        }

        // 幂等：同一个 commandId 重复到达（重试 / 重连补发）只应用一次
        const prior = this.#idem.get(frame.commandId);
        if (prior?.status === 'done') {
            link.send({ type: 'done', id: frame.id, commandId: frame.commandId, data: prior.data, seq: prior.seq });
            return;
        }
        if (prior?.status === 'failed') {
            link.send({
                type: 'err',
                id: frame.id,
                code: prior.code,
                message: prior.message,
                retryable: prior.retryable,
            });
            return;
        }
        if (prior?.status === 'running') {
            // 还在跑：告诉调用方「已受理」，结果等 `$command.finished`
            link.send({ type: 'accepted', id: frame.id, commandId: frame.commandId, at: this.#cursor });
            return;
        }

        const parsed = def.input.safeParse(frame.data);
        if (!parsed.success) {
            this.#reject(
                link,
                frame.id,
                frame.commandId,
                'E_INVALID_ARGUMENT',
                `命令 ${frame.name} 入参不符`,
                parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            );
            return;
        }

        /** 受理点：这个命令能产生的最早事件位置 */
        const acceptedAt = this.#cursor;
        this.#idem.set(frame.commandId, { status: 'running' });
        if (def.mode === 'deferred') {
            this.#deferred.set(frame.commandId, { pending: 0, ok: true, sawDefer: false });
        }

        let result: CommandResult<z.output<K['state']>, unknown>;
        try {
            result = await def.handler(this.#commandContext(frame.commandId), parsed.data);
        } catch (err) {
            const ae = toActorError(err);
            this.#idem.set(frame.commandId, {
                status: 'failed',
                code: ae.code,
                message: ae.message,
                retryable: ae.retryable,
            });
            this.#deferred.delete(frame.commandId);
            link.send({ type: 'err', id: frame.id, code: ae.code, message: ae.message, retryable: ae.retryable });
            return;
        }

        let seq: Cursor;
        try {
            seq = await this.#commit(result, frame.commandId);
        } catch (err) {
            const ae = toActorError(err);
            this.#idem.set(frame.commandId, {
                status: 'failed',
                code: ae.code,
                message: ae.message,
                retryable: ae.retryable,
            });
            this.#deferred.delete(frame.commandId);
            link.send({ type: 'err', id: frame.id, code: ae.code, message: ae.message, retryable: ae.retryable });
            return;
        }

        const record = this.#deferred.get(frame.commandId);
        if (record) record.output = result.output;

        if (def.mode === 'deferred') {
            this.#idem.set(frame.commandId, { status: 'running' });
            link.send({ type: 'accepted', id: frame.id, commandId: frame.commandId, at: acceptedAt });
            return;
        }

        this.#idem.set(frame.commandId, { status: 'done', data: result.output, seq });
        link.send({ type: 'done', id: frame.id, commandId: frame.commandId, data: result.output, seq });

        // 同步命令也可能排了后续单元（长活尾巴）；那一支跑完再发 `$command.finished`
        if (record && record.sawDefer && record.pending === 0) await this.#finishCommand(frame.commandId);
    }

    #commandContext(commandId: CommandId): CommandContext<z.output<K['state']>> {
        return {
            uri: this.uri,
            // 快照而不是 live getter：一个工作单元内状态不会变（提交发生在单元结束之后），
            // 所以「读到的 state」恒等于「这个单元开始时已提交的状态」。
            state: this.#state as Readonly<z.output<K['state']>>,
            now: this.#now(),
            commandId,
            defer: (fn) => this.#deferFor(commandId, fn),
        };
    }

    /** `ctx.defer` 的实现：排一个后续工作单元到队尾（**不能 await**，见 docs/01 §五） */
    #deferFor(
        commandId: CommandId,
        fn: (
            ctx: CommandContext<z.output<K['state']>>,
        ) => Promise<CommandResult<z.output<K['state']>, unknown>> | CommandResult<z.output<K['state']>, unknown>,
    ): void {
        const record = this.#deferred.get(commandId) ?? { pending: 0, ok: true, sawDefer: false };
        this.#deferred.set(commandId, record);
        record.sawDefer = true;
        record.pending += 1;

        void this.#enqueue(async () => {
            try {
                const r = await fn(this.#commandContext(commandId));
                await this.#commit(r, commandId);
                if (r.output !== undefined) record.output = r.output;
            } catch (err) {
                const ae = toActorError(err);
                record.ok = false;
                record.code = ae.code;
                record.message = ae.message;
                await this.#commit(
                    { events: [{ name: FAULT, data: { commandId, code: ae.code, message: ae.message } }] },
                    commandId,
                ).catch((e) => this.#onLog({ level: 'error', message: '落 $fault 失败', error: e }));
            } finally {
                record.pending -= 1;
                if (record.pending === 0) await this.#finishCommand(commandId);
            }
        }).catch((err) => this.#onLog({ level: 'error', message: '后续单元崩了', error: err }));
    }

    /** 长活尾巴跑完：把结果记成事件（`done` 帧早就发过了，这里只补收尾） */
    async #finishCommand(commandId: CommandId): Promise<void> {
        const record = this.#deferred.get(commandId);
        if (!record || !record.sawDefer) return;
        this.#deferred.delete(commandId);
        const data = { commandId, ok: record.ok, code: record.code, message: record.message, output: record.output };
        const seq = await this.#commit({ events: [{ name: COMMAND_FINISHED, data }] }, commandId);
        const prior = this.#idem.get(commandId);
        if (prior?.status !== 'failed') {
            this.#idem.set(commandId, { status: 'done', data: record.output, seq });
        }
    }

    // ── 查询 ────────────────────────────────────────────────────────────────

    async #handleQuery(frame: Extract<Frame, { type: 'query' }>, link: Link): Promise<void> {
        if (frame.name === EVENTS) {
            const parsed = EVENTS_INPUT.safeParse(frame.data ?? {});
            if (!parsed.success) {
                this.#reject(link, frame.id, undefined, 'E_INVALID_ARGUMENT', '`$events` 入参不符');
                return;
            }
            const after = (parsed.data.after ?? CURSOR_ZERO) as Cursor;
            const events = await this.#store.read(after, { include: parsed.data.include, limit: parsed.data.limit });
            link.send({ type: 'ok', id: frame.id, data: { events, cursor: this.#cursor }, watermark: this.#cursor });
            return;
        }

        if (frame.name === COMMAND_STATUS) {
            const parsed = COMMAND_STATUS_INPUT.safeParse(frame.data ?? {});
            if (!parsed.success) {
                this.#reject(link, frame.id, undefined, 'E_INVALID_ARGUMENT', '`$command.status` 入参不符');
                return;
            }
            const record = this.#idem.get(parsed.data.commandId as CommandId);
            const data =
                record === undefined
                    ? { commandId: parsed.data.commandId, status: 'unknown' }
                    : record.status === 'done'
                      ? { commandId: parsed.data.commandId, status: 'done', output: record.data }
                      : record.status === 'running'
                        ? { commandId: parsed.data.commandId, status: 'running' }
                        : {
                              commandId: parsed.data.commandId,
                              status: 'failed',
                              code: record.code,
                              message: record.message,
                          };
            link.send({ type: 'ok', id: frame.id, data, watermark: this.#cursor });
            return;
        }

        const def = this.kind.queries[frame.name] as QueryDef<z.output<K['state']>> | undefined;
        if (!def) {
            this.#reject(link, frame.id, undefined, 'E_UNKNOWN_METHOD', `未声明查询：${frame.name}`);
            return;
        }
        const parsed = def.input.safeParse(frame.data);
        if (!parsed.success) {
            this.#reject(
                link,
                frame.id,
                undefined,
                'E_INVALID_ARGUMENT',
                `查询 ${frame.name} 入参不符`,
                parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            );
            return;
        }

        const ctx: QueryContext<z.output<K['state']>> = { uri: this.uri, state: this.#state, now: this.#now() };

        try {
            if (def.fanout) {
                const targets = dedupeTargets(await def.fanout.targets(ctx, parsed.data));
                let results: readonly PerTarget[] = [];
                let receipts: FanoutReceipt[] = [];

                if (targets.length > 0) {
                    if (!this.#port) {
                        throw new ActorError('E_UNAVAILABLE', `查询 ${frame.name} 需要扇出端口，但 actor 没注入 port`);
                    }
                    const fan = await runFanout({
                        targets,
                        name: def.fanout.subquery,
                        data: parsed.data,
                        port: this.#port,
                        timeoutMs: def.fanout.timeoutMs ?? this.#fanoutTimeoutMs,
                        now: this.#now,
                    });
                    results = fan.results;
                    receipts = fan.receipts;
                    // 全败 = 一条答案都没拿到 ⇒ 执行轴失败（不是“部分成功”）
                    if (allFailed(results)) {
                        const meta: Meta = { fanout: receipts };
                        link.send({
                            type: 'err',
                            id: frame.id,
                            code: 'E_UNAVAILABLE',
                            message: `查询 ${frame.name} 的 ${results.length} 个目标全都没答`,
                            retryable: true,
                            meta,
                        });
                        return;
                    }
                }

                const output = await def.fanout.aggregate({ ctx, input: parsed.data, results, receipts });
                const data = def.output.parse(output);
                const meta: Meta | undefined = receipts.length > 0 ? { fanout: receipts } : undefined;
                link.send({ type: 'ok', id: frame.id, data, watermark: this.#cursor, meta });
                return;
            }

            if (!def.resolve) {
                throw new ActorError('E_UNKNOWN_METHOD', `查询 ${frame.name} 既没有 resolve 也没有 fanout`);
            }
            const output = await def.resolve(ctx, parsed.data);
            const data = def.output.parse(output);
            link.send({ type: 'ok', id: frame.id, data, watermark: this.#cursor });
        } catch (err) {
            const ae = toActorError(err);
            link.send({ type: 'err', id: frame.id, code: ae.code, message: ae.message, retryable: ae.retryable });
        }
    }

    // ── 提交 / 广播 ─────────────────────────────────────────────────────────

    /**
     * 原子收尾：事件 → 快照 → 广播。返回提交后的事件游标。
     * 事件与状态一起验：`state` 过 kind 的 schema，事件过 kind 的 `events`（`$` 走 runtime 自己的）。
     */
    async #commit(
        result: { state?: z.output<K['state']>; events?: readonly EventRecord[] },
        commandId?: CommandId,
    ): Promise<Cursor> {
        const incoming: NewEntry[] = [];
        for (const event of result.events ?? []) {
            const schema = event.name.startsWith('$')
                ? RUNTIME_EVENT_SCHEMAS[event.name]
                : (this.kind.events[event.name] as z.ZodType | undefined);
            if (!schema) throw new ActorError('E_UNKNOWN_METHOD', `未声明事件：${event.name}`);
            const parsed = schema.safeParse(event.data);
            if (!parsed.success) {
                throw new ActorError(
                    'E_INVALID_ARGUMENT',
                    `事件 ${event.name} 数据不符：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
                );
            }
            incoming.push({ name: event.name, at: this.#now(), data: parsed.data, commandId });
        }

        const nextState =
            result.state === undefined ? this.#state : (this.kind.state.parse(result.state) as z.output<K['state']>);

        const appended: JournalEntry[] = incoming.length > 0 ? await this.#store.append(incoming) : [];
        const cursor = appended.length > 0 ? appended[appended.length - 1]!.seq : this.#cursor;

        if (result.state !== undefined || appended.length > 0) {
            await this.#store.save({ state: nextState, cursor });
        }

        this.#state = nextState;
        this.#cursor = cursor;

        if (appended.length > 0) this.#broadcast(appended);
        return cursor;
    }

    #broadcast(entries: readonly JournalEntry[]): void {
        for (const entry of entries) {
            for (const link of this.#links) {
                link.send({
                    type: 'event',
                    name: entry.name,
                    data: entry.data,
                    seq: entry.seq,
                    at: entry.at,
                    commandId: entry.commandId,
                });
            }
        }
    }

    #reject(
        link: Link,
        id: Extract<Frame, { type: 'cmd' }>['id'],
        commandId: CommandId | undefined,
        code: ActorCode,
        message: string,
        issues?: { path: string; message: string }[],
    ): void {
        link.send({ type: 'rejected', id, commandId, code, message, issues });
    }
}

/** 同一个 target 只问一次（成员重绑定时 state 里可能出现重复地址） */
function dedupeTargets(targets: readonly Target[]): Target[] {
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const t of targets) {
        if (seen.has(t.target)) continue;
        seen.add(t.target);
        out.push(t);
    }
    return out;
}

/** 工厂：`createActor({ kind, uri })` */
export function createActor<K extends Kind>(opts: CreateActorOptions<K>): Actor<K> {
    return new Actor(opts);
}

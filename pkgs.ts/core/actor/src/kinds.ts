// kinds.ts — 声明层：一个 actor 会什么，全在一个 `defineKind(...).build()` 里。
//
// 为什么是声明而不是“注册一堆 handler”：runtime 要用声明做三件它必须做的事 ——
//   1. 校验入参（kind 的 zod 只校验 `data` 这一层，见 wire.ts）；
//   2. 知道哪些方法是命令（写入 + 幂等 + 失重放）哪些是查询（读，可扇出）；
//   3. 知道事件名的封闭集合（journal 记录要能按名字筛）。
//
// 链式构建是为了**零注解**：`ctx.state` / `input` / 返回值都是从 zod schema 推的，
// 写错了编译期就红（不用记 `RoomState` 这类类型名，也不用写泛型实参）。
//
//   const roomKind = defineKind({ name: 'diy.room', state: RoomState, initial })
//       .command('post', { input: PostIn, output: PostOut }, (ctx, input) => ({ ... }))
//       .query('get', { input: GetIn, output: GetOut }, (ctx, input) => ...)
//       .fanoutQuery('roster', { input: RosterIn, output: RosterOut, subquery: 'live', targets, aggregate })
//       .build();

import type { z } from 'zod';

import type { PerTarget } from './fanout.js';
import type { CommandId, FanoutReceipt, Target } from './wire.js';
import { RESERVED_PREFIX } from './wire.js';

/** actor 启动时喂给 `initial()` 的东西 */
export interface KindSeed {
    readonly uri: string;
    readonly now: number;
}

/** 一条业务事件（`name` 必须是声明过的） */
export interface EventRecord {
    readonly name: string;
    readonly data: unknown;
}

/**
 * handler 的副作用**显式返回**，不在 ctx 上偷偷改：
 * runtime 因此能在一次提交里原子地「追加事件 → 落快照 → 推进游标」，
 * 失败了整批丢弃 —— 状态和事件不会打架。
 */
export interface Effects<S> {
    /** 新状态（不写 = 不变）。runtime 会用 `state` schema 校验后再落 */
    readonly state?: S;
    /** 本次要追加的事件（按数组顺序，seq 由 store 分配） */
    readonly events?: readonly EventRecord[];
}

export interface CommandResult<S, O> extends Effects<S> {
    /** 命令输出；没输出就省（配 `output: z.void()`） */
    readonly output?: O;
}

export interface CommandContext<S> {
    readonly uri: string;
    /** **只读**状态：改状态 = 返回新的 `state` */
    readonly state: Readonly<S>;
    readonly now: number;
    readonly commandId: CommandId;
    /**
     * 把一个后续工作单元排到队列尾（长活用）。
     * **不要 await** —— 队列是串行的，在队列内等队列 = 自锁。
     * 失败会被 runtime 变成 `$fault` 事件，不会静默。
     */
    defer(fn: (ctx: CommandContext<S>) => Promise<CommandResult<S, unknown>> | CommandResult<S, unknown>): void;
}

export interface QueryContext<S> {
    readonly uri: string;
    readonly state: Readonly<S>;
    readonly now: number;
}

export type CommandMode = 'sync' | 'deferred';

export interface CommandDef<
    S,
    In extends z.ZodType = z.ZodType,
    Out extends z.ZodType = z.ZodType,
    M extends CommandMode = CommandMode,
> {
    // 存的是**schema 本身**，不是它的输出类型：`z.input<...>` 要靠 schema 才算得出来。
    // （早先存 `z.ZodType<O>` 时输入类型已经丢了 —— `z.input` 只能给 `unknown`，
    //  于是调用方那层看起来有类型、实际什么都没校验。）
    readonly input: In;
    readonly output: Out;
    /**
     * sync（默认）：handler 跑完 → 回 `done`
     * deferred：handler 只负责受理 → 回 `accepted`，长活走 `ctx.defer`，收尾发 `$command.finished`
     *
     * `M` 保留字面量（不是宽化成 `CommandMode`）：调用方那层要靠它在**类型上**区分
     * 「回值」还是「回受理回执」，见 api.ts `CmdValue`。
     */
    readonly mode: M;
    readonly handler: (
        ctx: CommandContext<S>,
        input: z.output<In>,
    ) => Promise<CommandResult<S, z.output<Out>>> | CommandResult<S, z.output<Out>>;
}

export interface AggregateArgs<S, I> {
    readonly ctx: QueryContext<S>;
    readonly input: I;
    /** 逐项结果：**每个 target 都有一项**，没拿到的 `answered: false` */
    readonly results: readonly PerTarget[];
    /** 与 results 同序的执行回执（runtime 会原样放进帧的 `meta.fanout`） */
    readonly receipts: readonly FanoutReceipt[];
}

export interface FanoutSpec<S, I, O> {
    /** 在 target 上执行的方法名（target 侧必须声明同名 query） */
    readonly subquery: string;
    /** **摆放知识只有 actor 知道**：从 state 算出该问谁（调用方不许指定 targets） */
    readonly targets: (ctx: QueryContext<S>, input: I) => readonly Target[] | Promise<readonly Target[]>;
    /** 把逐项结果折成业务答案 —— 「读不到」必须在 `data` 里有它自己的一项 */
    readonly aggregate: (args: AggregateArgs<S, I>) => O | Promise<O>;
    readonly timeoutMs?: number;
}

export interface QueryDef<S, In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
    readonly input: In;
    readonly output: Out;
    /** 本地答（projection）：与 `fanout` 二选一 */
    readonly resolve?: (ctx: QueryContext<S>, input: z.output<In>) => z.output<Out> | Promise<z.output<Out>>;
    /** 多目标扇出：与 `resolve` 二选一 */
    readonly fanout?: FanoutSpec<S, z.output<In>, z.output<Out>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = CommandDef<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = QueryDef<any, any, any>;

export interface Kind<
    D extends z.ZodType = z.ZodType,
    E extends Record<string, z.ZodType> = Record<string, z.ZodType>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    C extends Record<string, AnyCommand> = Record<string, AnyCommand>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Q extends Record<string, AnyQuery> = Record<string, AnyQuery>,
> {
    readonly name: string;
    /** 状态 schema：`initial()` 的产物、`defer` 提交的新状态、落盘快照都过它 */
    readonly state: D;
    readonly initial: (seed: KindSeed) => z.output<D>;
    /** 事件名 → schema（封闭集合；`$` 前缀是 runtime 保留，业务不许占） */
    readonly events: E;
    readonly commands: C;
    readonly queries: Q;
}

export type StateOf<K extends Kind> = z.output<K['state']>;
export type CmdNames<K extends Kind> = keyof K['commands'] & string;
export type QueryNames<K extends Kind> = keyof K['queries'] & string;
export type EventNames<K extends Kind> = keyof K['events'] & string;

export type CmdMode<K extends Kind, N extends CmdNames<K>> = K['commands'][N]['mode'];
export type CmdInput<K extends Kind, N extends CmdNames<K>> = z.input<K['commands'][N]['input']>;
export type CmdOutput<K extends Kind, N extends CmdNames<K>> = z.output<K['commands'][N]['output']>;
export type QueryInput<K extends Kind, N extends QueryNames<K>> = z.input<K['queries'][N]['input']>;
export type QueryOutput<K extends Kind, N extends QueryNames<K>> = z.output<K['queries'][N]['output']>;
export type EventData<K extends Kind, N extends EventNames<K>> = z.output<K['events'][N]>;

export interface KindInit<D extends z.ZodType, E extends Record<string, z.ZodType>> {
    readonly name: string;
    readonly state: D;
    readonly initial: (seed: KindSeed) => z.output<D>;
    readonly events?: E;
}

/**
 * 链式构建器。类型参数逐个累积（`C` / `Q` 越链越全），所以
 * `build()` 出来的 Kind 带着**每一条**方法的入参/出参类型，client 侧据此推导。
 */
export class KindBuilder<
    D extends z.ZodType,
    E extends Record<string, z.ZodType>,
    // 起点必须是 `{}` 而不是 `Record<string, never>`：后者带**字符串索引签名**，
    // 连带 `keyof C` 变成 `string` —— 于是 `CmdNames` / `CmdInput` 全退化成 `string` / `unknown`，
    // 「类型从 schema 推」就成了空话（拼错名字也不报错）。`{}` 的 keyof 是 `never`，链上一层层长。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    C extends Record<string, AnyCommand> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Q extends Record<string, AnyQuery> = {},
> {
    readonly #name: string;
    readonly #state: D;
    readonly #initial: (seed: KindSeed) => z.output<D>;
    readonly #events: E;
    readonly #commands = new Map<string, AnyCommand>();
    readonly #queries = new Map<string, AnyQuery>();

    constructor(init: KindInit<D, E>) {
        assertDeclaredName(init.name, 'kind');
        this.#name = init.name;
        this.#state = init.state;
        this.#initial = init.initial;
        this.#events = (init.events ?? {}) as E;
        for (const name of Object.keys(this.#events)) assertDeclaredName(name, 'event');
    }

    /** 命令：写入路径。默认 `sync`（跑完回 `done`），长活用 `mode: 'deferred'` */
    command<N extends string, I extends z.ZodType, O extends z.ZodType, M extends CommandMode = 'sync'>(
        name: N,
        spec: { input: I; output: O; mode?: M },
        handler: (
            ctx: CommandContext<z.output<D>>,
            input: z.output<I>,
        ) => Promise<CommandResult<z.output<D>, z.output<O>>> | CommandResult<z.output<D>, z.output<O>>,
    ): KindBuilder<D, E, C & Record<N, CommandDef<z.output<D>, I, O, M>>, Q> {
        this.#claim(name, 'command');
        this.#commands.set(name, {
            input: spec.input,
            output: spec.output,
            mode: spec.mode ?? 'sync',
            handler,
        } as AnyCommand);
        return this as unknown as KindBuilder<D, E, C & Record<N, CommandDef<z.output<D>, I, O, M>>, Q>;
    }

    /** 查询（本地答）：读路径，不排队等写，但读的是**当前已提交**的同一份 state */
    query<N extends string, I extends z.ZodType, O extends z.ZodType>(
        name: N,
        spec: { input: I; output: O },
        resolve: (ctx: QueryContext<z.output<D>>, input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
    ): KindBuilder<D, E, C, Q & Record<N, QueryDef<z.output<D>, I, O>>> {
        this.#claim(name, 'query');
        this.#queries.set(name, { input: spec.input, output: spec.output, resolve } as AnyQuery);
        return this as unknown as KindBuilder<D, E, C, Q & Record<N, QueryDef<z.output<D>, I, O>>>;
    }

    /**
     * 查询（多目标扇出）：targets 从 state 算，runtime 并发问、逐项收结果，
     * 回执进 `meta.fanout`，业务状态由 `aggregate` 自己写（**没有 partial**）。
     */
    fanoutQuery<N extends string, I extends z.ZodType, O extends z.ZodType>(
        name: N,
        spec: {
            input: I;
            output: O;
            subquery: string;
            targets: (
                ctx: QueryContext<z.output<D>>,
                input: z.output<I>,
            ) => readonly Target[] | Promise<readonly Target[]>;
            aggregate: (args: AggregateArgs<z.output<D>, z.output<I>>) => z.output<O> | Promise<z.output<O>>;
            timeoutMs?: number;
        },
    ): KindBuilder<D, E, C, Q & Record<N, QueryDef<z.output<D>, I, O>>> {
        this.#claim(name, 'query');
        this.#queries.set(name, {
            input: spec.input,
            output: spec.output,
            fanout: {
                subquery: spec.subquery,
                targets: spec.targets,
                aggregate: spec.aggregate,
                timeoutMs: spec.timeoutMs,
            },
        } as AnyQuery);
        return this as unknown as KindBuilder<D, E, C, Q & Record<N, QueryDef<z.output<D>, I, O>>>;
    }

    build(): Kind<D, E, C, Q> {
        return {
            name: this.#name,
            state: this.#state,
            initial: this.#initial,
            events: this.#events,
            commands: Object.fromEntries(this.#commands) as C,
            queries: Object.fromEntries(this.#queries) as Q,
        };
    }

    #claim(name: string, what: 'command' | 'query'): void {
        assertDeclaredName(name, what);
        if (this.#commands.has(name) || this.#queries.has(name)) {
            throw new Error(`[actor] 方法名重复：${name}（命令与查询共用一个命名空间）`);
        }
        if (name in this.#events) {
            throw new Error(`[actor] 方法名与事件名冲突：${name}`);
        }
    }
}

/** 入口：`defineKind({...})` 拿到构建器 */
export function defineKind<D extends z.ZodType, E extends Record<string, z.ZodType> = Record<string, never>>(
    init: KindInit<D, E>,
): KindBuilder<D, E> {
    return new KindBuilder(init);
}

function assertDeclaredName(name: string, what: string): void {
    if (!name) throw new Error(`[actor] ${what} 名不能为空`);
    if (name.startsWith(RESERVED_PREFIX)) {
        throw new Error(`[actor] ${what} 名不能以 "${RESERVED_PREFIX}" 开头（runtime 保留）：${name}`);
    }
}

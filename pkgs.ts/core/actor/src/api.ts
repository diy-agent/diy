// api.ts — 调用方的**函数层**：把契约摊成一组静态类型的方法，调用即得值。
//
// 为什么要有这一层（不到 100 行，但它把「跑到才知道」变成「写的时候就对」）：
//   raw 层（client.ts）是三个动词 + `Outcome` 判别联合 —— `client.cmd('add', { by: 2 })`：
//   方法名是字符串、结果是联合、真正的值要自己从 `outcome.data` 里捞。于是每个调用点都得
//   `if (!outcome.ok)`，字段名拼错只会在**跑到**的时候炸。
//
//   这一层把同一次调用写成：
//       const { n } = await counter.add({ by: 2 });
//   名字拼错 → 编译期红；入参字段写错 → 编译期红；失败 → 抛 `ActorError`（带 code）。
//
// 分层与 rpc 一一对应（`pkgs.ts/core/rpc`）：
//   defineKind(...)        ↔ defineService({ name, api })     契约（类型从 schema 推）
//   serveActor({ kind })   ↔ service.bind(server, handlers)   服务端（不用逐条绑方法）
//   useKind(kind, client)  ↔ service.use(client)              调用方（函数级，得值）
//   client.cmd/query/watch ↔ 底层 binding 的原始调用           逃生口（要 Outcome 时用）
//
// 为什么不把这三样也做进 kind：它们是**调用方**的事。同一个 kind，UI 想要函数层，
// 网关想要 raw 帧 —— 所以是「契约一份，视图两种」，不是两种契约。

import { ActorError } from './errors.js';
import type { ActorClient, CmdOptions, QueryOptions, WatchOptions } from './client.js';
import type {
    CmdInput,
    CmdMode,
    CmdNames,
    CmdOutput,
    EventData,
    EventNames,
    Kind,
    QueryInput,
    QueryNames,
    QueryOutput,
} from './kinds.js';
import type { CommandId, Cursor } from './wire.js';

/** 长活（`mode: 'deferred'`）命令的返回值：受理了，位置在 `at`，结果从事件流里拿 */
export interface Accepted {
    readonly accepted: true;
    readonly at: Cursor;
}

/**
 * 「没有字段」的入参长什么样：`z.object({})` 推出来是 `Record<string, never>`（不是 `{}`），
 * `z.void()` 推出来是 `void`。两种都算空 —— 于是 `counter.reset()` 不用写成 `counter.reset({})`。
 */
type EmptyInput<I> = [I] extends [void | undefined] ? true : [I] extends [Record<string, never>] ? true : false;

type InputArgs<I> = EmptyInput<I> extends true ? [] : [data: I];

/** 命令的返回值：sync 回 output，deferred 只回受理回执（真结果在事件里） */
export type CmdValue<K extends Kind, N extends CmdNames<K>> =
    CmdMode<K, N> extends 'deferred' ? Accepted : CmdOutput<K, N>;

export type CmdMethod<K extends Kind, N extends CmdNames<K>> = (
    ...args: [...InputArgs<CmdInput<K, N>>, opts?: CmdOptions]
) => Promise<CmdValue<K, N>>;

export type QueryMethod<K extends Kind, N extends QueryNames<K>> = (
    ...args: [...InputArgs<QueryInput<K, N>>, opts?: QueryOptions]
) => Promise<QueryOutput<K, N>>;

/** 一条事件带上它的 name 与载荷类型（判别联合，按 `name` 收窄） */
export type EventOf<K extends Kind, N extends EventNames<K> = EventNames<K>> = {
    readonly [E in N]: {
        readonly name: E;
        readonly data: EventData<K, E>;
        readonly seq: Cursor;
        readonly at: number;
        readonly commandId?: CommandId;
    };
}[N];

/**
 * 函数层的最终形状：**业务方法就是契约里那些名字**，一个不多一个不少；
 * 协议侧的三样用 `$` 前缀隔开（`$` 是 runtime 保留前缀，kind 声明不出这种名字，
 * 所以永远不会撞）。
 */
export type BoundActor<K extends Kind> = {
    readonly [N in CmdNames<K>]: CmdMethod<K, N>;
} & {
    readonly [N in QueryNames<K>]: QueryMethod<K, N>;
} & {
    /** 实时事件（不补历史）。返回退订函数 */
    $on<E extends EventNames<K>>(name: E, handler: (data: EventData<K, E>) => void): () => void;
    /** 补历史 + 追实时，逐条带类型 */
    $watch(opts?: WatchOptions): AsyncIterable<EventOf<K>>;
    /** 逃生口：同一个 client 的 raw 层（要 `Outcome` 或 `$events` 时用） */
    readonly $client: ActorClient<K>;
};

/**
 * 把契约绑到一个 client 上：`const counter = useKind(counterKind, client)`。
 *
 * 失败一律抛 `ActorError`（`code` 原样保留，`retryable` 也在）。不想 try/catch 就还用 raw 层 ——
 * 两层的差别只有这一条：**raw 把失败当返回值，函数层把失败当异常**。
 */
export function useKind<K extends Kind>(kind: K, client: ActorClient<K>): BoundActor<K> {
    const bound: Record<string, unknown> = {};

    for (const name of Object.keys(kind.commands)) {
        const fill = emptyInputOf(kind.commands[name]!);
        bound[name] = async (data: unknown = fill, opts: CmdOptions = {}) => {
            const outcome = await client.cmd(name as CmdNames<K>, data as never, opts);
            if (!outcome.ok) throw new ActorError(outcome.code, outcome.message, { retryable: outcome.retryable });
            // deferred：output 不进 `accepted` 帧，只有一个位置
            return outcome.accepted ? { accepted: true as const, at: outcome.at } : outcome.data;
        };
    }

    for (const name of Object.keys(kind.queries)) {
        const fill = emptyInputOf(kind.queries[name]!);
        bound[name] = async (data: unknown = fill, opts: QueryOptions = {}) => {
            const outcome = await client.query(name as QueryNames<K>, data as never, opts);
            if (!outcome.ok) throw new ActorError(outcome.code, outcome.message, { retryable: outcome.retryable });
            return outcome.data;
        };
    }

    bound.$client = client;
    bound.$on = (name: string, handler: (data: unknown) => void) =>
        client.onEvent((event) => {
            if (event.name === name) handler(event.data);
        });
    bound.$watch = async function* (opts?: WatchOptions): AsyncIterable<EventOf<K>> {
        for await (const event of client.watch(opts)) yield event as EventOf<K>;
    };

    return bound as BoundActor<K>;
}

/**
 * 「不写实参」时该往帧里放什么。
 *
 * 类型上 `InputArgs` 允许 `counter.reset()`，但帧里 `data` 不能是 `undefined` ——
 * actor 会拿它去 `schema.safeParse`，`z.object({})` 于是报「expected object, received undefined」。
 * 所以绑定时探一次：这个 schema 收不收 `{}`。收就补 `{}`；不收（`z.void()` 之类）就保持 `undefined`
 * ——那类声明要的正是 `undefined`，补 `{}` 反而会被拒。
 */
function emptyInputOf(def: { readonly input: { safeParse(value: unknown): { success: boolean } } }): unknown {
    return def.input.safeParse({}).success ? {} : undefined;
}

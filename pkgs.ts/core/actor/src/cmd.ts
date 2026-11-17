/**
 * @diy-agent/actor/cmd —— 声明式外壳：契约（cmd）与实现（implement）分居两个文件。
 *
 * 内核（./index.ts）的接缝是「位置参数 + $call(name, args, opts)」，跨进程时每个方法
 * 都得在桥里手写一遍转手。这里换一种写法，且**和 rpc 一样把 api / impl 分开**：
 *
 *   room.api.ts   cmd({ input, output })               // 客户端可 import，零实现
 *   room.impl.ts  implement(roomApi, setup, handlers)  // 只在服务端，可自由 import fs
 *
 * 为什么必须分开：契约里裹着实现，bundler 会顺着 impl 的 import 图（node:fs、
 * server-only 依赖）整棵打进客户端包。所以 cmd() 只装 schema，run 在 handlers 里。
 *
 * 和手写桥（examples/06-rpc-bridge）的区别只在省掉样板，**不换协议**：
 * 底下仍然是 rpc 的 mountService / createTypedClient / transport，取消仍然是 rpc 的
 * cancel 帧 → opts.signal → 内核的调用级 signal。入参被约束成「一个对象」，为的是让
 * `(input, opts?)` 与 rpc 的 `(input, options?)` 同形 —— 于是 signal 能当第二个参数直接传。
 *
 * 判据：这个文件不超过 190 行。它只做「声明 → 两端的形状转换」，
 * 一旦开始出现「重试 / 超时 / 编解码」，说明又把 rpc 的东西抄进来了。
 */

import { RpcSchema, createTypedClient, mountService } from '@diy-agent/rpc';
import type { ClientBinding, ProcedureMeta, ServerBinding } from '@diy-agent/rpc';
import { z } from 'zod';
import { actor, type Api, type Life } from './index.js';

/* ────────────────────────────────────────────────────────────
 * 1. 声明（客户端可以 import 的只有这一段）
 * ──────────────────────────────────────────────────────────── */

type Shape = Record<string, z.ZodTypeAny>;

/** 一条命令的契约：**只有 schema，没有实现** */
export interface Cmd<S extends Shape, O> {
    readonly input: S;
    readonly output: z.ZodType<O>;
    readonly desc?: string;
}

/**
 * 声明一条命令。
 *
 * `const S` 是关键：不加会把 { who: z.string() } 宽化成 Shape，入参退化成索引签名。
 * 出参 schema **只参与类型推导，不做运行时校验**（rpc 不校验 output），所以写精确点
 * 没有开销，换来客户端拿到 Promise<number> 而不是 Promise<unknown>。
 */
export function cmd<const S extends Shape, O>(opts: { input: S; output: z.ZodType<O>; desc?: string }): Cmd<S, O> {
    return opts;
}

export type CmdTree = Record<string, Cmd<any, any>>;

/** 从 Cmd 里取入参/出参 —— 条件类型里 S / O 必须 `infer` 出来，否则退化成 any */
type In<T> = T extends Cmd<infer S, any> ? { [K in keyof S]: z.output<S[K]> } : never;
type Out<T> = T extends Cmd<any, infer O> ? O : never;

/** 本地方法与远程 client 共用的调用签名 */
export type CmdsOf<C extends CmdTree> = {
    [K in keyof C]: (input: In<C[K]>, opts?: Opts) => Promise<Out<C[K]>>;
};

/** 契约树 —— 直接是 rpc 的 meta，createTypedClient 靠它推类型 + 校验入参 */
export type ApiOf<C extends CmdTree> = {
    [K in keyof C]: ProcedureMeta<In<C[K]>, Out<C[K]>, never, never, 'unary'>;
};

type Opts = { readonly signal?: AbortSignal };

/* ────────────────────────────────────────────────────────────
 * 2. 实现（只在服务端 / 本地出现）
 * ──────────────────────────────────────────────────────────── */

/**
 * handler 的第二个参数。`signal` 是 getter，转发内核的 `life.signal` —— 读的才是
 * 「这一次调用」的合并信号（actor 被 close + 本次调用被 abort），取快照会让取消失效。
 */
export interface CmdCtx<St> {
    readonly signal: AbortSignal;
    /** setup 的返回值；同一次 actor 生命周期内是同一个 */
    readonly state: St;
}

type Handlers<A extends CmdTree, St> = {
    [K in keyof A]: (input: In<A[K]>, ctx: CmdCtx<St>) => Out<A[K]> | Promise<Out<A[K]>>;
};

/** implement() 的产物 —— 交给 actorOf() 就能跑 */
export interface CmdImpl<A extends CmdTree> {
    readonly api: A;
    /** 给内核的工厂（建状态 + 绑 handler）。**不要直接调用**，用 actorOf() */
    readonly factory: (life: Life) => Api;
}

/**
 * 绑定实现。参数类型、返回值类型都从 `api` 推出，handlers 里**不用重复标注**；
 * 少实现一个方法、参数名写错、返回类型错，都是编译错误。状态放 setup 里，
 * handler 通过 ctx.state 访问 —— 于是 impl 文件可以自由 `import fs`，它不会进客户端包。
 */
export function implement<A extends CmdTree, St>(
    api: A,
    setup: (life: Life) => St,
    handlers: Handlers<A, St>,
): CmdImpl<A> {
    return {
        api,
        factory: (life) => {
            const state = setup(life);
            const ctx: CmdCtx<St> = {
                get signal() {
                    return life.signal;
                },
                state,
            };
            // 按字符串键遍历时编译器跟不住「这个键 → 这个 handler」，收在库里一处。
            const table = handlers as unknown as Record<string, (input: unknown, ctx: CmdCtx<St>) => unknown>;
            const impl: Api = {};
            for (const k of Object.keys(api)) impl[k] = (input: unknown) => table[k]!(input, ctx);
            return impl;
        },
    };
}

/* ────────────────────────────────────────────────────────────
 * 3. 三端
 * ──────────────────────────────────────────────────────────── */

export type CmdActor<C extends CmdTree> = CmdsOf<C> & {
    readonly api: ApiOf<C>;
    readonly closed: boolean;
    idle(): Promise<void>;
    close(): Promise<void>;
};

/**
 * 把 implement() 的产物包成 actor。复用内核：handler 直接当方法，入参只有一个对象 ⇒
 * `$call(name, [input], opts)` 恰好等于 `room[name](input, opts)`，桥里不用搬参数。
 * 契约是静态的，所以不需要等 factory 执行就能建出 api。
 */
export function actorOf<C extends CmdTree>(impl: CmdImpl<C>): CmdActor<C> {
    const core = actor(impl.factory);

    const calls: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};

    for (const [k, def] of Object.entries(impl.api)) {
        calls[k] = (input: unknown, opts?: Opts) => core.$call(k, [input], opts);
        api[k] = metaOf(def);
    }

    calls.api = api;
    calls.idle = () => core.idle();
    calls.close = () => core.close();
    Object.defineProperty(calls, 'closed', { get: () => core.closed });

    return calls as CmdActor<C>;
}

const metaOf = (def: Cmd<any, any>): ProcedureMeta<any, any, never, never, 'unary'> =>
    RpcSchema.unary({ input: def.input, output: def.output, desc: def.desc });

const toMeta = (tree: CmdTree): ApiOf<CmdTree> =>
    Object.fromEntries(Object.entries(tree).map(([k, def]) => [k, metaOf(def)])) as ApiOf<CmdTree>;

/** 把 actor 挂到一根管子上（服务端） */
export function serveActor<C extends CmdTree>(room: CmdActor<C>, server: ServerBinding, prefix: string): void {
    const call = room as unknown as Record<string, (i: unknown, o?: Opts) => Promise<unknown>>;
    const handlers: Record<string, unknown> = {};
    for (const k of Object.keys(room.api)) {
        // 一行转手：rpc 的 signal → opts.signal → 内核的调用级 signal
        handlers[k] = ({ input, signal }: { input: unknown; signal: AbortSignal }) => call[k]!(input, { signal });
    }
    // 第二处断言：按字符串键遍历，编译器跟不住「k → 该键的 handler 类型」。
    // 对使用者没有泄漏 —— 传进来和拿到手的都是精确类型。
    mountService(server, {
        prefix,
        api: room.api,
        handlers: handlers as unknown as Parameters<typeof mountService>[1]['handlers'],
    });
}

/** 从契约生成强类型 client（客户端，只 import api 文件） */
export function createActorClient<C extends CmdTree>(opts: {
    readonly api: C;
    readonly client: ClientBinding;
    readonly prefix: string;
}): CmdsOf<C> {
    return createTypedClient(opts.client, toMeta(opts.api), { prefix: opts.prefix }) as CmdsOf<C>;
}

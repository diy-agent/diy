/**
 * @diy-agent/actor/cmd —— 声明式外壳：一条 cmd 同时是本地方法、契约、服务端 handler。
 *
 * 内核（./index.ts）的接缝是「位置参数 + $call(name, args, opts)」，所以跨进程时
 * 每个方法都得在桥里手写一遍转手。这里换一种写法：
 *
 *   cmd({ input: { who: z.string() }, output: z.number() }, ({ who }) => ...)
 *
 * 声明一次，得到三样东西，且**类型全部从这一处推出**（没有第二份 api 声明）：
 *   1. 本地方法   actorOf(make).say({ who: '你' })
 *   2. 契约       apiOf(make)             → rpc 的 ProcedureMeta
 *   3. 服务端     serveActor(room, server, 'room')
 *   4. 客户端     createActorClient({ api: apiOf(make), client, prefix })
 *
 * 和手写桥（examples/06-rpc-bridge）的区别只在省掉样板，**不换协议**：
 * 底下仍然是 rpc 的 mountService / createTypedClient / transport，
 * 取消仍然是 rpc 的 cancel 帧 → 这里转成 opts.signal → 内核的调用级 signal。
 *
 * 入参被约束成「一个对象」。这不是限制，是换取 `(input, opts?)` 与 rpc 的
 * `(input, options?)` 同形 —— 于是 signal 能当第二个参数直接传，不需要 $call。
 *
 * 判据：这个文件不超过 190 行。它只做「声明 → 两端的形状转换」，
 * 一旦开始出现「重试 / 超时 / 编解码」，说明又把 rpc 的东西抄进来了。
 */

import { RpcSchema, createTypedClient, mountService } from '@diy-agent/rpc';
import type { ClientBinding, ProcedureMeta, ServerBinding } from '@diy-agent/rpc';
import { z } from 'zod';
import { actor, type Api, type Life } from './index.js';

/* ────────────────────────────────────────────────────────────
 * 1. 声明
 * ──────────────────────────────────────────────────────────── */

type Shape = Record<string, z.ZodTypeAny>;

/** 一条命令：入参 shape + 出参 schema + 实现 */
export interface Cmd<S extends Shape, O> {
    readonly input: S;
    readonly output: z.ZodType<O>;
    readonly desc?: string;
    /** 实现。要感知取消就读闭包里的 life.signal（和内核一致） */
    readonly run: (input: { [K in keyof S]: z.output<S[K]> }) => O | Promise<O>;
}

/**
 * 声明一条命令。
 *
 * `const S` 是关键：不加会把 { who: z.string() } 宽化成 Shape，入参退化成索引签名。
 * 出参 schema **只参与类型推导，不做运行时校验**（rpc 不校验 output），所以写精确点
 * 没有开销，换来客户端拿到 Promise<number> 而不是 Promise<unknown>。
 */
export function cmd<const S extends Shape, O>(
    opts: { input: S; output: z.ZodType<O>; desc?: string },
    run: (input: { [K in keyof S]: z.output<S[K]> }) => O | Promise<O>,
): Cmd<S, O> {
    return { ...opts, run };
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

export type CmdActor<C extends CmdTree> = CmdsOf<C> & {
    readonly api: ApiOf<C>;
    readonly closed: boolean;
    idle(): Promise<void>;
    close(): Promise<void>;
};

/* ────────────────────────────────────────────────────────────
 * 2. 本地实例
 * ──────────────────────────────────────────────────────────── */

/**
 * 把 cmd 树包成 actor。
 *
 * 复用内核：cmd 的 run 直接当方法，入参只有一个对象 ⇒
 * `$call(name, [input], opts)` 恰好等于 `room[name](input, opts)`，桥里不用搬参数。
 */
export function actorOf<C extends CmdTree>(factory: (life: Life) => C): CmdActor<C> {
    let tree: C | undefined;

    const core = actor((life) => {
        const t = factory(life);
        tree = t;
        const impl: Api = {};
        for (const [k, def] of Object.entries(t)) impl[k] = def.run;
        return impl;
    });

    const calls: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};

    for (const [k, def] of Object.entries(tree!)) {
        calls[k] = (input: unknown, opts?: Opts) => core.$call(k, [input], opts);
        api[k] = RpcSchema.unary({ input: def.input, output: def.output, desc: def.desc });
    }

    calls.api = api;
    calls.idle = () => core.idle();
    calls.close = () => core.close();
    Object.defineProperty(calls, 'closed', { get: () => core.closed });

    return calls as CmdActor<C>;
}

/* ────────────────────────────────────────────────────────────
 * 3. 两端
 * ──────────────────────────────────────────────────────────── */

/** 把 actor 挂到一根管子上（服务端） */
export function serveActor<C extends CmdTree>(room: CmdActor<C>, server: ServerBinding, prefix: string): void {
    const call = room as unknown as Record<string, (i: unknown, o?: Opts) => Promise<unknown>>;
    const handlers: Record<string, unknown> = {};
    for (const k of Object.keys(room.api)) {
        // 一行转手：rpc 的 signal → opts.signal → 内核的调用级 signal
        handlers[k] = ({ input, signal }: { input: unknown; signal: AbortSignal }) => call[k]!(input, { signal });
    }
    // 唯一一处断言：按字符串键遍历，编译器跟不住「k → 该键的 handler 类型」。
    // 对使用者没有泄漏 —— 传进来和拿到手的都是精确类型。
    mountService(server, {
        prefix,
        api: room.api,
        handlers: handlers as unknown as Parameters<typeof mountService>[1]['handlers'],
    });
}

/** 从契约生成强类型 client（客户端，不需要 actor 实例） */
export function createActorClient<C extends CmdTree>(opts: {
    readonly api: ApiOf<C>;
    readonly client: ClientBinding;
    readonly prefix: string;
}): CmdsOf<C> {
    return createTypedClient(opts.client, opts.api, { prefix: opts.prefix }) as CmdsOf<C>;
}

/** 静态契约：不建实例、不建链，只取 meta 树 */
const NEVER = new AbortController().signal;

/**
 * 从 factory 取出契约，**状态直接丢掉**。
 *
 * 客户端不能有 actor 实例（那会把状态和整条链也建起来），但需要 api。
 * 代价：factory 的**闭包初始化在两端各跑一次** ⇒ 必须无副作用。
 * 这条纪律和 rpc 的 api.ts「必须无副作用」是同一条，只是从两个文件收成了一个工厂。
 *
 * 也意味着客户端 import 契约会把 factory 的实现打进包 —— 别在 factory 里 import fs。
 */
export function apiOf<C extends CmdTree>(factory: (life: Life) => C): ApiOf<C> {
    const life: Life = { signal: NEVER, closed: false };
    const tree = factory(life);
    const api: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(tree)) {
        api[k] = RpcSchema.unary({ input: def.input, output: def.output, desc: def.desc });
    }
    return api as ApiOf<C>;
}

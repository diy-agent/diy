/**
 * @diy-agent/actor —— 一个 actor = 一份私有状态 + 一条串行链 + 一张方法表。
 *
 * 全部能力就两件：
 *   1. serial()  把工作单元排成一条链
 *   2. actor()   把方法表包成 actor，类型原样保留
 *
 * 跨进程不是第三件能力 —— **这个文件不含任何网络代码**。跨进程由宿主选一根管子
 * （rpc 的 ws / http / electron，或自己十行包出来的 IPC）桥进来，见
 * examples/06-rpc-bridge 与 docs/bridging-rpc.md。「状态 + 串行链」在第几个进程
 * 都一样，需要换的只是「帧怎么送」。
 *
 * 嫌手写桥麻烦就用 `@diy-agent/actor/cmd`：`cmd({ input, output }, run)` 声明一次，
 * 同时得到本地方法 / rpc 契约 / 服务端 handler / 强类型 client。那条路径依赖 zod + rpc，
 * 所以放在子路径里 —— `import '@diy-agent/actor'` 仍然是零依赖。
 *
 * 为此留的唯一接缝是 `$call(fn, args, { signal })` —— 外部桥能把「对面取消了」
 * 变成方法内部的 `life.signal.aborted`，不需要 actor 知道自己在远端。
 *
 * 没有：幂等表、游标、快照格式、多目标、生命周期树、状态机。
 * 那些只有「要持久化」时才需要，谁需要谁在外面加（examples/05-persist 十几行）。
 *
 * 判据：这个文件不超过 190 行；超过说明又把平台的东西塞进来了。
 * （150 → 180 是为了 `$call` + 调用级 signal：远程取消要能真的传到方法里，
 *   否则跨进程取消只能做到「客户端不等了」，对面还在跑。）
 */

const noop = () => {};

export type Fn = (...args: any[]) => any;
export type Api = Record<string, Fn>;

/* ────────────────────────────────────────────────────────────
 * 1. 串行链
 * ──────────────────────────────────────────────────────────── */

export interface Chain {
    /** 投递一个工作单元；返回它自己的 promise —— 这个 promise 就是回执 */
    send<T>(fn: () => T | Promise<T>): Promise<Awaited<T>>;
    /** 等到链上现有工作单元全部跑完（含失败的） */
    idle(): Promise<void>;
}

/**
 * 一条 promise 链。
 *
 * 为什么不用 mailbox 数组 + drain 循环：
 *   - 闭包直接挂在链尾，跑完自然被 GC，不需要自己维护数组
 *   - 链会自己往下走，不需要 drain
 *   - 每个 send() 自己的 promise 就是回执，不需要 id → resolve 表
 *
 * `.then(fn, fn)` 是关键：前一个失败也继续跑下一个。
 * 一条命令炸了不该让后面所有命令一起卡死。
 */
export function serial(): Chain {
    let tail: Promise<unknown> = Promise.resolve();

    return {
        send<T>(fn: () => T | Promise<T>): Promise<Awaited<T>> {
            const next = tail.then(fn, fn) as Promise<Awaited<T>>;
            tail = next.then(noop, noop); // 链尾永不 reject
            return next;
        },

        async idle(): Promise<void> {
            let prev: Promise<unknown>;
            do {
                prev = tail;
                await prev;
                // 等待期间可能又有新投递，所以要比一次
            } while (prev !== tail);
        },
    };
}

/* ────────────────────────────────────────────────────────────
 * 2. actor
 * ──────────────────────────────────────────────────────────── */

/**
 * 生命周期：给 factory 里的代码看「这次该不该停」。
 *
 * signal 覆盖两种来源，方法内部不用区分：
 *   - actor 被 close() 了
 *   - **这一次调用**被外部 abort 了（跨进程时由桥接层带过来）
 */
export interface Life {
    readonly signal: AbortSignal;
    readonly closed: boolean;
}

/** 一次调用的选项。业务代码用不到 —— 只有桥接层填 signal */
export interface CallOpts {
    signal?: AbortSignal;
}

/** 方法表 → 全部 Promise 化的方法表 */
export type ActorOf<M extends Api> = {
    [K in keyof M]: (...args: Parameters<M[K]>) => Promise<Awaited<ReturnType<M[K]>>>;
} & {
    readonly closed: boolean;
    /** 等到队列排空 */
    idle(): Promise<void>;
    /** 关掉：abort 正在跑的，之后新调用一律 reject */
    close(): Promise<void>;
    /**
     * 跟 `room.say(...)` 完全同一件事，只是能带 opts。
     * 桥接层用它把「对面取消了这个 id」接成 signal；业务代码直接调方法即可。
     */
    $call<K extends keyof M & string>(
        name: K,
        args: Parameters<M[K]>,
        opts?: CallOpts,
    ): Promise<Awaited<ReturnType<M[K]>>>;
};

/**
 * 把一个方法表包成 actor。
 *
 * 状态放闭包里 —— 外面只拿到方法，碰不到 state，所以不存在「绕过队列改状态」。
 *
 * @param factory 返回方法表；参数 life 用来感知关闭
 */
export function actor<M extends Api>(factory: (life: Life) => M): ActorOf<M> {
    const chain = serial();
    const ctl = new AbortController();

    // 当前这次调用的 signal。life.signal 是 getter，所以方法里任何时刻读到都是准的。
    // 串行链保证同一时刻最多一个方法在跑，所以一个槽就够。
    let callSig: AbortSignal | undefined;
    let merged: AbortSignal | undefined;
    let mergedOf: AbortSignal | undefined;

    const curSignal = (): AbortSignal => {
        if (!callSig) return ctl.signal;
        if (mergedOf !== callSig) {
            merged = AbortSignal.any([ctl.signal, callSig]);
            mergedOf = callSig;
        }
        return merged!;
    };

    const impl = factory({
        get signal() {
            return curSignal();
        },
        get closed() {
            return curSignal().aborted;
        },
    });

    let closed = false;
    const api: Record<PropertyKey, unknown> = {};

    const run = (name: string, args: unknown[], opts?: CallOpts) =>
        chain.send(async () => {
            if (closed) throw new Error(`actor closed: ${name}()`);
            callSig = opts?.signal;
            try {
                return await (impl[name] as Fn).apply(impl, args);
            } finally {
                callSig = undefined;
            }
        });

    for (const [name, fn] of Object.entries(impl)) {
        if (typeof fn !== 'function') continue;
        api[name] = (...args: unknown[]) => run(name, args);
    }

    api.$call = (name: string, args: unknown[], opts?: CallOpts) => run(name, args, opts);
    api.idle = () => chain.idle();

    api.close = async () => {
        if (closed) return;
        closed = true;
        ctl.abort();
        await chain.idle();
    };

    Object.defineProperty(api, 'closed', { get: () => closed });

    return api as ActorOf<M>;
}

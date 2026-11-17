/**
 * @diy-agent/actor —— 一个 actor = 一份私有状态 + 一条串行链 + 一张方法表。
 *
 * 全部能力就两件：
 *   1. serial()  把工作单元排成一条链
 *   2. actor()   把方法表包成 actor，类型原样保留
 *
 * 跨进程不是第三件能力 —— 你只要把「帧怎么送」换掉，`actor()` 本身不动
 * （手写适配器见 examples/06-net，约 20 行）。
 *
 * 没有：帧协议、幂等表、游标、快照格式、多目标、生命周期树、状态机。
 * 那些只有「要持久化 / 要跨机器」时才需要，谁需要谁在外面加（examples/05-persist、06-net 各加十几行）。
 *
 * 判据：这个文件不超过 150 行；超过说明又把平台的东西塞进来了。
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

/** 生命周期：给 factory 里的代码看「我是不是被关了」 */
export interface Life {
    readonly signal: AbortSignal;
    readonly closed: boolean;
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
    const impl = factory({
        signal: ctl.signal,
        get closed() {
            return ctl.signal.aborted;
        },
    });

    let closed = false;
    const api: Record<PropertyKey, unknown> = {};

    for (const [name, fn] of Object.entries(impl)) {
        if (typeof fn !== 'function') continue;

        api[name] = (...args: unknown[]) =>
            chain.send(async () => {
                if (closed) throw new Error(`actor closed: ${name}()`);
                return fn.apply(impl, args);
            });
    }

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

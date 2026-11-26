// globals.ts —— 注入给模型代码的**那套东西**（策略化里的另一个不变面）。
//
// 三条规矩（每条都对应一个真坑）：
//   1. **键集合固定、每个键可描述**：只放函数 / RPC client / JSON-able 值。
//      塞一个"只有本进程才有的活对象" = 明天换子进程就崩。
//   2. **realm 内置显式给**：`vm` 的 context 是独立 realm，`JSON` / `Date` / `Promise`
//      都不是主进程那个 —— 不显式注入会在 `instanceof` 与 `JSON.stringify` 上出诡异结果。
//   3. **不给 process / require / 网络逃逸口之外的东西**：这一层是"防误用"，不是安全边界。
//
// 这里**不 import 任何 diy 包**（除了类型）：引擎要能在任何进程里装配，
// `apiHelp` 清单由调用方生成后传进来（它那边才知道 api 树长什么样）。

/** 一条可调 RPC 的物化描述：`api` 是 Proxy（不可枚举），检索只能靠这份清单 */
export interface ApiHelpItem {
    /** 方法全名（`diy2.bots.update`） */
    readonly path: string;
    /** 一行说明（取自契约的 `desc`，没有就没有） */
    readonly desc?: string;
    /** `unary` / `server` / `client` / `bidi` */
    readonly mode: string;
}

export interface GlobalsOptions {
    /** 强类型 RPC 调用端（`createTypedClient` 的产物）—— 业务唯一入口 */
    readonly api: unknown;
    /** `api` 的物化清单；不给 = 模型拿不到 `apiHelp`（api 对它就是黑盒） */
    readonly apiHelp?: readonly ApiHelpItem[] | undefined;
    /** 取消信号：`sleep` 与工具层都靠它收 */
    readonly signal?: AbortSignal | undefined;
    /** 业务方追加（键必须满足上面规矩 1） */
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** 受 `signal` 约束的睡眠：模型要等就用它，别裸写 `setTimeout` 等长活 */
function makeSleep(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
    return (ms: number) =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(new Error('aborted'));
                return;
            }
            const onAbort = (): void => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
}

/**
 * 装配注入物。
 *
 * 返回值直接喂给 `CodeRuntime.run({ globals })` —— 引擎会在这之上覆盖 `console`。
 */
export function makeGlobals(opts: GlobalsOptions): Record<string, unknown> {
    const globals: Record<string, unknown> = {
        api: opts.api,
        sleep: makeSleep(opts.signal),
        now: (): number => Date.now(),
        clone: <T>(value: T): T => structuredClone(value),
        // realm 内置：vm 的 context 不会自动带这些
        JSON,
        Math,
        Date,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        fetch,
        ...opts.extra,
    };
    if (opts.apiHelp !== undefined) {
        // 函数而不是数组：清单可能是懒生成的（api 树在启动后才齐），也避免同一份对象被改
        globals['apiHelp'] = (): readonly ApiHelpItem[] => opts.apiHelp ?? [];
    }
    if (opts.signal !== undefined) globals['signal'] = opts.signal;
    return globals;
}

/** 把清单渲染成给模型看的一段文本（塞进工具描述或让模型自己调 `apiHelp()`） */
export function formatApiHelp(items: readonly ApiHelpItem[]): string {
    if (items.length === 0) return '（这个会话没有挂任何 RPC）';
    return items
        .map((item) => (item.desc === undefined ? `- ${item.path}` : `- ${item.path} — ${item.desc}`))
        .join('\n');
}

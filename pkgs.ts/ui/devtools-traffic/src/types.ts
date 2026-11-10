/**
 * types.ts —— 插件要用的**线上形状投影**（##518）
 *
 * 为什么自己定义而不是 import diy-app 的 `shared/traffic-record`：
 * 那个文件在 **app** 里（`apps/diy-app/src/shared/`），公共包里 import 它 = 让插件依赖具体 app，
 * 与「插件只是 rpc 客户端」矛盾。
 *
 * 这里的字段是**宽松投影**：只声明插件真正读的几项，其余 `unknown` 原样透传。
 * 下一步：把这些形状抽成 `@diy-agent/devtools-protocol`（纯类型 + zod），
 * 由 app 侧与插件侧**共同**依赖 —— 那时才是跨进程契约的真源。
 */

/** 一条流量记录（`traffic.query` / `traffic.recent` 的元素） */
export interface TrafficEntry {
    /** ISO 时间 */
    readonly at?: string;
    /** `llm` / `http` / `probe` */
    readonly kind?: string;
    /** 请求方法（http）或 `llm` */
    readonly method?: string;
    /** 地址 */
    readonly url?: string;
    /** 模型名（kind=llm） */
    readonly model?: string;
    /** 状态码 */
    readonly status?: number;
    /** 耗时毫秒 */
    readonly ms?: number;
    /** 归属任务 */
    readonly taskUri?: string;
    /** 其余字段原样保留（详情面板展示用） */
    readonly [key: string]: unknown;
}

export interface QueryResult {
    readonly records: readonly TrafficEntry[];
    readonly scanned: number;
    readonly files: readonly string[];
    readonly hits: number;
    readonly truncated: boolean;
    readonly ms: number;
}

export interface LogFiles {
    readonly dir: string;
    readonly files: readonly string[];
    readonly dates: readonly string[];
    readonly bytes: number;
    readonly detail: readonly { readonly file: string; readonly date: string; readonly bytes: number; readonly today: boolean }[];
}

/** 宿主能力：**唯一**的依赖面（rpc 客户端据此实现，见 client.ts） */
export interface DevtoolsHost {
    invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
}

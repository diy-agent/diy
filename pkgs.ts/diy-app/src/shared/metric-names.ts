/**
 * 指标契约（**零依赖**）：名字 / 桶 / 扁平视图类型。
 *
 * 为什么不留在 `metrics.ts` 里：那份文件顶层 `import` 了 `@opentelemetry/sdk-metrics`，
 * 而 renderer（面板）也要认这些名字 —— 从那里导入会把整个 OTel SDK 打进渲染进程。
 * 这里只放**纯常量与纯类型**，main 与 renderer 共用同一份真源。
 *
 * `metrics.ts` 从本文件 re-export，因此既有导入点不需要改。
 */

/** 指标名（唯一真源：记录方与读取方都从这里取，别各写字符串）。 */
export const METRIC_NAMES = {
    /** 后台 run 启动次数（登记即 +1，含最终起不来的那条 —— 它与 settle 配平） */
    runStarted: "job.run.started_total",
    /** 后台 run 收口次数（按终态与结局分维） */
    runSettled: "job.run.settled_total",
    /** 当前在跑的 run 数（up-down counter，started 与 settled 成对维护） */
    runRunning: "job.run.running",
    /** run 时长（毫秒，自定义桶：1s / 10s / 1m / 5m / 30m） */
    runDuration: "job.run.duration_ms",
} as const;

/**
 * 时长直方图的桶边界（毫秒）。
 *
 * 选这五档的理由：我们的长活从秒级到半小时级都有，而 OTel 缺省桶止于 10 秒 ——
 * 一条 20 分钟的命令与一条 30 秒的命令会落进**同一个桶**，等于没分档。
 */
export const DURATION_BUCKETS_MS = [1_000, 10_000, 60_000, 300_000, 1_800_000] as const;

/**
 * 维度（OTel 叫 attributes）的宽松复刻 —— 不 import otel 类型。
 *
 * 为何用 `unknown` 而不复刻 `AttributeValue` 联合：那套联合允许 `(string|null|undefined)[]`
 * 这类嵌套，复刻一遍只是抄噪音，而且维度本来就是**动态**的（谁记谁定）。
 * 读取方一律先 `String(x ?? 缺省)`，不信任具体形状。
 */
export type MetricAttrs = Record<string, unknown>;

/** 直方图的聚合值（SDK 2.x `Aggregation` 的扁平复刻）。 */
export interface HistogramValue {
    count: number;
    sum: number;
    min: number;
    max: number;
    boundaries: number[];
    counts: number[];
}

/** 一条指标的扁平视图 —— **CLI / 面板 / 将来的导出器共用的唯一形状**。 */
export interface MetricPointView {
    /** 维度（OTel 叫 attributes）：任务 URI、终态、类型… */
    attrs: MetricAttrs;
    /** 标量（counter / gauge）或直方图聚合值 */
    value: number | HistogramValue;
}

export interface MetricView {
    name: string;
    description: string;
    unit: string;
    /** counter / up-down counter 都是 cumulative：进程重启归零（标准行为，抓取方认得） */
    type: "counter" | "gauge" | "histogram";
    points: MetricPointView[];
}

export interface MetricsSnapshot {
    /** 快照时刻（ISO）——「上次探测」永远是一个明确时刻，人看得懂 */
    at: string;
    metrics: MetricView[];
}

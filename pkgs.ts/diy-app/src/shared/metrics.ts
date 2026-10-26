/**
 * metrics.ts — 内部指标（**内存快照 + 数据规范，不做 HTTP 导出、不启定时器**）
 *
 * 为什么用 OTel 的术语而不接 OTLP：我们要的是**统一的指标形状**（counter / gauge /
 * histogram + attributes + 单位后缀），不是上报协议。单机 Electron app 里没有第二个
 * 消费者要推送 —— 出口只有两个，都在本进程内：`diy job metrics`（JSON，给 agent 与
 * 面板）与将来的 app 内监控图。真要接 Prometheus / Grafana 时，只需在
 * `snapshotMetrics()` 之上加一个渲染器（OpenMetrics 文本 / OTLP protobuf），
 * **不动这里的模型**。
 *
 * 三条纪律（与 `run-view.ts` 同一条）：
 *   1. **拉不推**：`PullMetricReader` 不注册任何 timer，没人问就零开销。
 *   2. **指标不是真源**：随时可以丢光重算；真源是活体表（`run-registry`）。
 *   3. **一份快照喂所有出口**：CLI / 面板 / 将来的导出器读的都是 `snapshotMetrics()`。
 *
 * 单位后缀照 OTel 约定：`_total` 只给单调递增的 counter，时间一律 `_ms`。
 *
 * ⚠️ `@opentelemetry/sdk-metrics@2.x` 的两个坑（实测踩过，别再踩）：
 *   · 它是 **CJS**，ESM 具名导入只能拿到 `require()` 静态分析得到的那 12 个名字
 *     （`MeterProvider` / `MetricReader` / `AggregationType` / `DataPointType` …）。
 *     `View` 类**根本没导出** —— `views` 参数收的是**纯对象** `ViewOptions`，不是 `View` 实例。
 *   · 默认直方图桶是 `[0,5,10,25,50,75,100,250,…]`，全挤在 10 秒内；我们的 run 是
 *     30 秒到 30 分钟，必须自定义 boundaries，否则所有真实数据都掉进最后一个桶。
 */
import type { Attributes, Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { AggregationType, MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";

import { DURATION_BUCKETS_MS, METRIC_NAMES } from "./metric-names";
import type { MetricPointView, MetricView, MetricsSnapshot } from "./metric-names";

/**
 * 名字 / 桶 / 扁平视图形状都在 `metric-names.ts`（零依赖）—— 渲染进程也要认它们，
 * 而本文件顶层带着 OTel SDK。这里只做**转发**，既有导入点不必改。
 */
export { DURATION_BUCKETS_MS, METRIC_NAMES };
export type { MetricPointView, MetricView, MetricsSnapshot };

/**
 * 指标名 → 类型。
 *
 * 为什么要有这张表：SDK 2.x 的 `DataPoint` **只有** `{attributes, startTime, endTime, value}`，
 * 既没有 `dataPointType` 字段，`MetricDescriptor` 也不带仪器类型 —— 快照里无从判断
 * 「这条是 counter 还是 gauge」。我们只定义这四个指标，直接查表比按值形状猜准。
 * （直方图靠 `typeof value !== "number"` 也能认出来，但 counter / up-down counter 认不出。）
 */
const METRIC_TYPES: Record<string, MetricView["type"]> = {
    [METRIC_NAMES.runStarted]: "counter",
    [METRIC_NAMES.runSettled]: "counter",
    // 语义上是 up-down counter；对外按 gauge 讲更贴人话（`job.run.running` 本来就是个瞬时量）
    [METRIC_NAMES.runRunning]: "gauge",
    [METRIC_NAMES.runDuration]: "histogram",
};

/**
 * 只拉不推的 reader：不注册 timer、不 fork 任何东西。
 * `collect()` 由调用方显式触发（一次即时聚合）。
 */
class PullMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {
        // 没有后台资源要收
    }
    protected async onForceFlush(): Promise<void> {
        // 没有缓冲要刷：聚合是即时的
    }
}

interface Instruments {
    started: Counter;
    settled: Counter;
    running: UpDownCounter;
    duration: Histogram;
}

/**
 * 仪器的**唯一来源**：本进程只有一个 meter、一个 scope，
 * 所以不挂 Resource / Scope 三层包装（CLI 上多两级只会让人以为有多个来源）。
 */
interface MetricsRuntime {
    instruments: Instruments;
    /** 显式拉一次（同步聚合），不触发任何定时器 */
    collect: () => Promise<Awaited<ReturnType<MetricReader["collect"]>>>;
}

function buildMetrics(): MetricsRuntime {
    const reader = new PullMetricReader();
    const provider = new MeterProvider({
        readers: [reader],
        // ⚠️ 纯对象 `ViewOptions`，不是 `new View(...)`（View 类没导出，见文件头）
        views: [
            {
                instrumentName: METRIC_NAMES.runDuration,
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: [...DURATION_BUCKETS_MS] },
                },
            },
        ],
    });
    const meter = provider.getMeter("diy.job");
    return {
        instruments: {
            started: meter.createCounter(METRIC_NAMES.runStarted, {
                description: "后台 run 启动次数（登记即计，含启动失败的那条）",
                unit: "1",
            }),
            settled: meter.createCounter(METRIC_NAMES.runSettled, {
                description: "后台 run 收口次数（按终态与结局分维）",
                unit: "1",
            }),
            running: meter.createUpDownCounter(METRIC_NAMES.runRunning, {
                description: "当前在跑的后台 run 数",
                unit: "1",
            }),
            duration: meter.createHistogram(METRIC_NAMES.runDuration, {
                description: "后台 run 从启动到收口的时长",
                unit: "ms",
            }),
        },
        collect: () => reader.collect(),
    };
}

let runtime = buildMetrics();

/**
 * 任务维度：没有 origin 的 run（将来的进程内任务 / 人为起的）统一落到这个值。
 * **不许缺席** —— 指标点缺维度会让「按任务聚合」在 UI 里静默漏掉一批。
 */
const NO_TASK = "_none";

function taskAttr(taskUri: string | undefined): string {
    return taskUri && taskUri.length > 0 ? taskUri : NO_TASK;
}

/** 一条后台 run 登记进活体表（**不是**命令真的跑起来 —— 起不来也记，settle 会配平）。 */
export function recordRunStarted(input: { taskUri?: string; kind?: string }): void {
    const attrs: Attributes = { task_uri: taskAttr(input.taskUri), kind: input.kind ?? "background" };
    runtime.instruments.started.add(1, attrs);
    runtime.instruments.running.add(1, { task_uri: taskAttr(input.taskUri) });
}

/**
 * 一条后台 run 收口（在 `settle` 里调用一次 —— 它已经是终态的唯一落点）。
 *
 * `state` 是活体表的四态（不会有 running），`outcome` 是可选的结局细分
 * （ok / fail / canceled / timeout）。两者分开的理由见 `run-status.ts`：
 * 「用户取消 / 超时」不是缺陷，挤进失败数会让面板与指标一起失真。
 */
export function recordRunSettled(input: {
    taskUri?: string;
    state: string;
    outcome?: string;
    durationMs?: number;
}): void {
    const task_uri = taskAttr(input.taskUri);
    runtime.instruments.settled.add(1, {
        task_uri,
        state: input.state,
        ...(input.outcome ? { outcome: input.outcome } : {}),
    });
    runtime.instruments.running.add(-1, { task_uri });
    if (input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
        runtime.instruments.duration.record(input.durationMs, { task_uri });
    }
}

/**
 * 拉一份快照（**唯一出口**）。没人调用 ⇒ 一次聚合都不发生。
 *
 * 扁平到 `{name, points}` 两层：OTLP 的 ResourceMetrics → ScopeMetrics 三层
 * 对本进程的用处为零（只有一个 meter）。
 */
export async function snapshotMetrics(): Promise<MetricsSnapshot> {
    const { resourceMetrics } = await runtime.collect();
    const metrics: MetricView[] = [];
    for (const scope of resourceMetrics.scopeMetrics) {
        for (const m of scope.metrics) {
            metrics.push({
                name: m.descriptor.name,
                description: m.descriptor.description ?? "",
                unit: m.descriptor.unit ?? "",
                type: typeOf(m.descriptor.name, m.dataPoints[0]),
                points: m.dataPoints.map(flattenPoint),
            });
        }
    }
    // 名字排序：两次快照可直接 diff（稳定输出是给人看的基本要求）
    metrics.sort((a, b) => a.name.localeCompare(b.name));
    return { at: new Date().toISOString(), metrics };
}

/** SDK 的 `DataPoint` 实际只有这四个字段（见 `METRIC_TYPES` 的解释）。 */
type RawPoint = { attributes: Attributes; value: unknown };

function typeOf(name: string, dp: RawPoint | undefined): MetricView["type"] {
    const known = METRIC_TYPES[name];
    if (known) return known;
    // 表里没有的（将来的指标）：直方图靠值形状能认（对象 vs 数字），其余按 counter 讲
    return dp && typeof dp.value !== "number" ? "histogram" : "counter";
}

function flattenPoint(dp: RawPoint): MetricPointView {
    const v = dp.value;
    if (typeof v === "number") return { attrs: dp.attributes, value: v };
    const h = v as {
        count?: number;
        sum?: number;
        min?: number;
        max?: number;
        buckets?: { boundaries: number[]; counts: number[] };
    };
    return {
        attrs: dp.attributes,
        value: {
            count: h.count ?? 0,
            sum: h.sum ?? 0,
            min: h.min ?? 0,
            max: h.max ?? 0,
            boundaries: h.buckets?.boundaries ?? [],
            counts: h.buckets?.counts ?? [],
        },
    };
}

/**
 * 测试专用：丢掉全部累计值、重建 provider。
 *
 * 生产代码**不许**调用 —— 指标一重置 counter 就从 0 开始，抓取方会当成 counter reset。
 * 只有 vitest 的多用例之间需要（模块级单例会累积）。
 */
export function __resetMetricsForTest(): void {
    runtime = buildMetrics();
}

import { performance } from 'node:perf_hooks';

// metrics-registry.ts —— op / RPC 耗时的进程内 histogram（零依赖，避免跨包循环）。
//
// 为什么单独一个模块而不塞进 prom-metrics.ts：`loop-lag.ts` 的 `timed` 要往里记 op，
// 而 prom-metrics.ts 反过来 import loop-lag 的类型。若让两者互相 import 就成环了。
// registry 谁都不依赖，loop-lag / app / prom-metrics 都单向依赖它。
//
// 为什么不用 OTel SDK：规格见 docs/plans/2026-11-28-observability-metrics-export.md，
// 第一版只服务本机观察，指标名按 OTel 约定（秒），将来换 OTLP 导出时格式不变。
// 这里只提供 histogram 的累加与 Prometheus 文本渲染，采样器在别处。

/** 耗时 bucket（秒）；op / rpc 共用一套，覆盖 5ms ~ 10s */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface Histogram {
    help: string;
    /** label 名顺序固定，渲染时按此顺序输出 */
    labelNames: readonly string[];
    /** key = label 值按 `\x00` 拼；value = 累加器 */
    series: Map<string, { count: number; sum: number; buckets: number[] }>;
}

const histograms = new Map<string, Histogram>();

function define(name: string, help: string, labelNames: readonly string[]): Histogram {
    let h = histograms.get(name);
    if (h === undefined) {
        h = { help, labelNames, series: new Map() };
        histograms.set(name, h);
    }
    return h;
}

// 先声明，保证即使没有任何样本，/metrics 里也有 HELP/TYPE（Prometheus 约定）。
define('diy2_op_duration_seconds', '同步重活（timed/timedAsync）耗时，全量采样', ['op']);
define('diy2_rpc_server_duration_seconds', 'RPC 方法耗时（unary）', ['rpc_method', 'rpc_status']);

/** 记录一次耗时；labels 按声明时的 labelNames 顺序给值 */
export function recordDuration(name: string, labels: readonly string[], seconds: number): void {
    const h = histograms.get(name);
    if (h === undefined) return; // 未声明的指标不记（拼错名字不该悄悄建 series）
    const key = labels.join('\x00');
    let entry = h.series.get(key);
    if (entry === undefined) {
        entry = { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
        h.series.set(key, entry);
    }
    entry.count += 1;
    entry.sum += seconds;
    DURATION_BUCKETS.forEach((bound, index) => {
        if (seconds <= bound) entry!.buckets[index]! += 1;
    });
}

/**
 * 给 RPC handlers 的叶子函数包一层耗时记录，返回同形状的新对象（不改原对象）。
 * handlers 是 `{ rooms: { list: fn }, bots: { update: fn } }` 这种嵌套对象；
 * 只包函数叶子，方法名 = 路径 join('.')（rooms.list），**不含任何 id 参数**（无高基数）。
 * 只对 unary（返回 Promise 的函数）计时；流式 generator 由 flow 层自行打点。
 */
export function wrapHandlers<T>(handlers: T, prefix = ''): T {
    if (typeof handlers === 'function') {
        const method = prefix === '' ? 'anonymous' : prefix;
        return ((...args: unknown[]) => {
            const started = performance.now();
            const result = (handlers as (...a: unknown[]) => unknown)(...args);
            const finish = (status: string): void => {
                recordDuration(
                    'diy2_rpc_server_duration_seconds',
                    [method, status],
                    (performance.now() - started) / 1000,
                );
            };
            if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
                return (result as Promise<unknown>).then(
                    (value) => {
                        finish('ok');
                        return value;
                    },
                    (error: unknown) => {
                        finish('error');
                        throw error;
                    },
                ) as T;
            }
            finish('ok');
            return result as T;
        }) as T;
    }
    if (handlers !== null && typeof handlers === 'object' && !Array.isArray(handlers)) {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(handlers as Record<string, unknown>)) {
            out[key] = wrapHandlers(value, prefix === '' ? key : `${prefix}.${key}`);
        }
        return out as T;
    }
    return handlers;
}

/** 渲染成 Prometheus 文本（histogram：各 le 的 bucket + sum + count） */
export function renderMetricsRegistry(): string {
    const lines: string[] = [];
    for (const [name, h] of histograms) {
        lines.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
        for (const [key, entry] of h.series) {
            const values = key.split('\x00');
            const pairs = h.labelNames.map((label, i) => `${label}="${values[i] ?? ''}"`).join(',');
            DURATION_BUCKETS.forEach((bound, index) => {
                const tail = pairs === '' ? `le="${String(bound)}"` : `${pairs},le="${String(bound)}"`;
                lines.push(`${name}_bucket{${tail}} ${String(entry.buckets[index])}`);
            });
            const infTail = pairs === '' ? 'le="+Inf"' : `${pairs},le="+Inf"`;
            lines.push(
                `${name}_bucket{${infTail}} ${String(entry.count)}`,
                `${name}_sum{${pairs}} ${String(entry.sum)}`,
                `${name}_count{${pairs}} ${String(entry.count)}`,
            );
        }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

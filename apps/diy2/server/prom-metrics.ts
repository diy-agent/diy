// prom-metrics.ts —— diy2 的 `/metrics`（Prometheus 文本格式）。
//
// 这是给外部监控（VictoriaMetrics / Prometheus / promtop）读的**第一版最小指标面**：
//   · 事件循环：lag（秒）、cpuRatio、按性质分的 blocked / stalls 累计值
//   · 机器水位：load1/5/15、逻辑核数、RSS
//   · 进程：CPU 秒数、uptime
//
// 为什么手写在装配层而不是先上 OTel Metrics SDK：这一版只服务“本机观察”；
// 指标名 / 单位按 docs/plans/2026-11-28-observability-metrics-export.md 的约定
// （单位一律秒 / 1 / 字节），以后换成 OTel SDK 时导出格式保持不变。
//
// 只导出**进程级聚合**：没有 roomId / botId / 消息内容，基数可控。

import { performance } from 'node:perf_hooks';
import { cpus, loadavg, freemem, totalmem } from 'node:os';
import { statSync } from 'node:fs';

import type { LoopLagCounters, LoopLagMonitor, LoopLagSnapshot } from './loop-lag';
import { renderMetricsRegistry } from './metrics-registry';

export interface MetricsInfo {
    readonly home: string;
    readonly launch: string;
    readonly env: string;
    /** 数据库文件路径；给了就出 diy2_db_size_bytes（main / wal / shm） */
    readonly dbPath?: string;
}

/** Prometheus 文本格式的标签值转义 */
export function labelValue(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function gauge(name: string, help: string, value: number, labels?: Record<string, string>): string {
    const pairs =
        labels === undefined
            ? ''
            : `{${Object.entries(labels)
                  .map(([key, val]) => `${key}="${labelValue(val)}"`)
                  .join(',')}}`;
    return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${pairs} ${String(value)}`;
}

function counter(name: string, help: string, value: number, labels?: Record<string, string>): string {
    const pairs =
        labels === undefined
            ? ''
            : `{${Object.entries(labels)
                  .map(([key, val]) => `${key}="${labelValue(val)}"`)
                  .join(',')}}`;
    return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}${pairs} ${String(value)}`;
}

function lagLines(snapshot: LoopLagSnapshot | undefined): string[] {
    if (snapshot === undefined) return [];
    return [
        gauge('diy2_event_loop_lag_max', '最近一个汇总窗口内最大事件循环卡顿（秒）', snapshot.max / 1000),
        gauge('diy2_event_loop_lag_p99', '事件循环卡顿 p99（秒）', snapshot.p99 / 1000),
        gauge('diy2_event_loop_lag_mean', '事件循环卡顿均值（秒）', snapshot.mean / 1000),
        gauge(
            'diy2_event_loop_cpu_ratio',
            '卡顿窗口内 CPU 时间 / 墙钟时间（≥0.5 = 本进程在算；≈0 = 被饿死）',
            snapshot.cpuRatio,
        ),
    ];
}

function counterLines(counters: LoopLagCounters): string[] {
    return [
        counter('diy2_event_loop_blocked_total', '累计卡住秒数（按性质）', counters.blockedSeconds.self, {
            verdict: 'self',
        }),
        counter('diy2_event_loop_blocked_total', '累计卡住秒数（按性质）', counters.blockedSeconds.starved, {
            verdict: 'starved',
        }),
        counter('diy2_event_loop_stalls_total', '累计卡顿次数（按性质）', counters.stalls.self, { verdict: 'self' }),
        counter('diy2_event_loop_stalls_total', '累计卡顿次数（按性质）', counters.stalls.starved, {
            verdict: 'starved',
        }),
    ];
}

/** 库文件大小（只在 /metrics 被抓时 stat 一次，低频）；读不到就跳过，不让监控带崩 app */
function dbSizeLines(dbPath: string | undefined): string[] {
    if (dbPath === undefined) return [];
    const lines: string[] = [];
    for (const [file, path] of [
        ['main', dbPath],
        ['wal', `${dbPath}-wal`],
        ['shm', `${dbPath}-shm`],
    ] as const) {
        try {
            lines.push(gauge('diy2_db_size_bytes', '数据库文件大小（字节）', statSync(path).size, { db_file: file }));
        } catch {
            // wal / shm 可能不存在（WAL 未启用或已 checkpoint），跳过即可
        }
    }
    return lines;
}

function processLines(): string[] {
    const usage = process.cpuUsage();
    const cpuSeconds = (usage.user + usage.system) / 1_000_000;
    const memory = process.memoryUsage();
    const [load1, load5, load15] = loadavg();
    return [
        counter('process_cpu_seconds_total', '进程累计 CPU 时间（秒）', cpuSeconds),
        gauge('process_uptime_seconds', '进程运行时长（秒）', process.uptime()),
        gauge('process_memory_usage', '进程 RSS（字节）', memory.rss),
        gauge('nodejs_heap_total', 'V8 堆总大小（字节）', memory.heapTotal),
        gauge('system_cpu_logical_count', '逻辑核数', Math.max(1, cpus().length)),
        gauge('system_load_average', '系统负载', load1 ?? 0, { window: '1m' }),
        gauge('system_load_average', '系统负载', load5 ?? 0, { window: '5m' }),
        gauge('system_load_average', '系统负载', load15 ?? 0, { window: '15m' }),
        gauge('system_memory_usage', '系统内存（字节）', totalmem() - freemem(), { state: 'used' }),
        gauge('system_memory_usage', '系统内存（字节）', freemem(), { state: 'free' }),
        gauge('system_memory_limit', '系统内存上限（字节）', totalmem()),
        gauge('nodejs_event_loop_utilization', '事件循环利用率（0~1）', performance.eventLoopUtilization().utilization),
    ];
}

// ── HTTP 请求耗时 ──────────────────────────────────────────────────
// 规格见 docs/plans/2026-11-28-observability-metrics-export.md §4.4：
// 只按**路由白名单**记，原始 path（roomId / botId）绝不进指标，避免高基数。
const HTTP_ROUTES = ['/api/info', '/api/metrics', '/api/migrate/state', '/metrics', '/rpc', '/static'] as const;
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export function httpRouteOf(pathname: string): string {
    if ((HTTP_ROUTES as readonly string[]).includes(pathname)) return pathname;
    if (pathname.startsWith('/api/')) return '/api/other';
    return '/static';
}

interface HttpBucket {
    count: number;
    sum: number;
    buckets: number[];
}

const httpRequests = new Map<string, HttpBucket>();

/** handle() 在 res 完成时调一次；status 只记 2xx / 4xx / 5xx 三档，不记原始 path */
export function recordHttpRequest(route: string, status: number, seconds: number): void {
    const key = `${route}|${status >= 500 ? '5xx' : status >= 400 ? '4xx' : '2xx'}`;
    let entry = httpRequests.get(key);
    if (entry === undefined) {
        entry = { count: 0, sum: 0, buckets: HTTP_BUCKETS.map(() => 0) };
        httpRequests.set(key, entry);
    }
    entry.count += 1;
    entry.sum += seconds;
    HTTP_BUCKETS.forEach((bound, index) => {
        if (seconds <= bound) entry!.buckets[index]! += 1;
    });
}

function httpLines(): string[] {
    const lines: string[] = [];
    for (const [key, entry] of httpRequests) {
        const [route, status] = key.split('|') as [string, string];
        const pairs = `http_route="${route}",status="${status}"`;
        HTTP_BUCKETS.forEach((bound, index) => {
            lines.push(
                `diy2_http_request_duration_seconds_bucket{${pairs},le="${String(bound)}"} ${String(entry.buckets[index])}`,
            );
        });
        lines.push(
            `diy2_http_request_duration_seconds_bucket{${pairs},le="+Inf"} ${String(entry.count)}`,
            `diy2_http_request_duration_seconds_sum{${pairs}} ${String(entry.sum)}`,
            `diy2_http_request_duration_seconds_count{${pairs}} ${String(entry.count)}`,
        );
    }
    if (lines.length === 0) return lines;
    return [
        '# HELP diy2_http_request_duration_seconds HTTP 请求耗时（秒）',
        '# TYPE diy2_http_request_duration_seconds histogram',
        ...lines,
    ];
}

/** 生成 `/metrics` 的完整文本（纯函数：monitor / info 都可注入，单测不需要起服务） */
export function renderPrometheus(monitor: LoopLagMonitor | undefined, info: MetricsInfo): string {
    const snapshot = monitor?.snapshot();
    const counters = monitor?.counters();
    // 同名 metric 的 HELP/TYPE 在 Prometheus 里只允许出现一次：lagLines 与 processLines
    // 都带 load / rss 时，后出现的那份只输出样本、不重复头。这里用简单去重保证合法。
    const seen = new Set<string>();
    const lines: string[] = [];
    const push = (chunk: string): void => {
        for (const line of chunk.split('\n')) {
            if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) {
                if (seen.has(line)) continue;
                seen.add(line);
            }
            lines.push(line);
        }
    };

    push(gauge('diy2_up', '本进程存活', 1));
    push(
        gauge('diy2_info', 'diy2 实例信息', 1, {
            home: info.home,
            launch: info.launch,
            env: info.env,
        }),
    );
    for (const chunk of lagLines(snapshot)) push(chunk);
    if (counters !== undefined) for (const chunk of counterLines(counters)) push(chunk);
    for (const chunk of processLines()) push(chunk);
    for (const chunk of dbSizeLines(info.dbPath)) push(chunk);
    for (const chunk of httpLines()) push(chunk);
    // registry（op / rpc histogram）自带 HELP/TYPE，直接接上
    const registry = renderMetricsRegistry();
    if (registry !== '') push(registry);
    return `${lines.join('\n')}\n`;
}

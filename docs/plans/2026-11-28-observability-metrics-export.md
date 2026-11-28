# 可观测性：把卡顿与系统参数导出给外部监控

2026-11-28。卡顿本体由另一会话处理，本文只解决「**怎么发现、怎么导出、给谁用**」。

## 1. 结论先说

- **仪表化只做一次**：用 OTel Metrics API 定义指标；是否导出、导出到哪，由装配层决定。
- **默认导出 = 同端口的 `/metrics`（Prometheus 文本格式）**：不需要额外进程，Prometheus / Grafana
  Alloy / VictoriaMetrics / Netdata / Uptime Kuma 都能直接抓。
- **可选导出 = OTLP push**：设了 `OTEL_EXPORTER_OTLP_ENDPOINT` 就额外推给 collector，
  collector 再分发到 Prometheus / Tempo / Loki。
- **保留 `/api/metrics` JSON**：给不想上 Prometheus 的轻量脚本用；它和 `/metrics` 共用同一份数据。
- **不要**在 app 里重造全套 node_exporter。机器级 metric（swap、pageins、磁盘）能拿就拿
  （见 §6.5），拿不到就交给宿主机的监控 agent；app 只保证把「自己这一侧」讲清楚。

关键判据（这次 lab 实测出来的）：

> 同一句「卡了 78 秒」，必须能区分 **本进程在算** 还是 **本进程没抢到 CPU**。
> 只看 lag 的监控一定会误判。

## 2. 现状与缺口

| 已有 | 位置 | 缺口 |
|---|---|---|
| OTel Logs（文件 + 终端） | `apps/diy2/server/log.ts` | 只有日志，没有时序指标 |
| 事件循环 lag + `timed` | `apps/diy2/server/loop-lag.ts` | 只在日志里；`timed` 只记超过 100ms 的 |
| `/api/metrics` | `apps/diy2/server/app.ts` | 人读 JSON，无历史、无标准格式 |
| `cpuRatio` / `load1` | loop-lag 新增 | 能判性质，但没有导出 |

`@opentelemetry/sdk-metrics` 目前**未安装**（只有 `api-logs` / `sdk-logs`）。
已验证 npm 上的兼容版本：`sdk-metrics@3.1.1`、`exporter-prometheus@0.301.2`
（其依赖 `core/resources@3.1.1`），`api@1.10.0` 是 peer。**所有 otel 包必须同一 minor**，
否则 `core` 会装两份、全局 provider 可能不共享。

## 3. 架构

```text
业务 / 装配层
  ├─ loop-lag / timed / rpc / http / db  ── record ──┐
  ├─ system sampler (os, process, v8)     ── observe ─┤
  └─ /api/metrics JSON（人读）                         │
                                                       ▼
                                        OTel Metrics API（无 SDK）
                                                       │
                                     MeterProvider（装配层唯一 import SDK）
                                       ├─ PrometheusExporter ── GET /metrics（pull，默认）
                                       └─ PeriodicExportingMetricReader ─ OTLP（push，可选）
```

分层沿用 `@diy-agent/log` 的裁决：**业务包只用 `@opentelemetry/api`，SDK 只在装配层**。
指标名 / 单位 / 属性在业务侧定义一次，导出器只做格式转换。

### 3.1 为什么选 Prometheus 文本

- 所有主流监控都吃这一口：Prometheus、VictoriaMetrics、Grafana Alloy、Thanos、Netdata、Uptime Kuma。
- 不需要常驻 collector；对本地单进程 app 成本最低。
- **拉取失败本身是信号**：进程卡死到无法响应 `/metrics` 时，Prometheus 的 `up == 0` 和
  `scrape_duration_seconds` 会留下痕迹，比进程自己报 lag 更可靠。
- 同一端口（app 的 `port`），不额外开监听、不额外加防火墙规则；`/metrics` 只在
  `127.0.0.1` 上可达（与 `/api` 同一信任边界）。

### 3.2 为什么还要留 OTLP 入口

多实例 / 远程 / 想同时接 traces 时，push 比逐实例抓取好管：collector 做去重、标签补全、
批量转发。用标准环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT` 激活即可，业务代码零改动。

## 4. 指标目录

命名用 OTel 规范（点分），单位一律 SI 基本单位（秒 / 字节 / 1）。
Prometheus 导出时点变下划线，monotonic sum 自动加 `_total`，histogram 自动生成
`_bucket` / `_sum` / `_count`（已核对 `exporter-prometheus@0.301.2` 源码）。

### 4.1 事件循环（核心）

| 指标 | 类型 | 单位 | 属性 | 说明 |
|---|---|---|---|---|
| `diy2.event_loop.lag` | histogram | s | — | 每 tick 的 lag 分布（tick 1s，粗粒度） |
| `diy2.event_loop.lag.max` | gauge（observable） | s | — | 最近一窗最大值，告警主用 |
| `diy2.event_loop.cpu_ratio` | gauge | 1 | — | 一窗内 CPU 时间 / 墙钟；≥0.5 自己在算 |
| `diy2.event_loop.blocked` | counter | s | `verdict=self\|starved` | 累计「卡住时长」，按性质分 |
| `diy2.event_loop.stalls` | counter | {stall} | `verdict` | 卡顿次数（>warnMs 才计） |
| `nodejs.event_loop.utilization` | gauge | 1 | — | `performance.eventLoopUtilization()`，看「平时忙不忙」 |

> 为什么不只用 `monitorEventLoopDelay`：它同步阻塞期间自己停摆，被 resolution 封顶，
> 测不出「卡死多久」。保留 `diy2.event_loop.lag`（自己记 tick）+ 一条更细的
> `nodejs.event_loop.utilization` 做互补。

### 4.2 进程 / 运行时

| 指标 | 类型 | 单位 | 属性 |
|---|---|---|---|
| `process.cpu.time` | counter | s | `state=user\|system` |
| `process.memory.usage` | gauge | By | — |
| `process.memory.virtual` | gauge | By | — |
| `process.uptime` | gauge | s | — |
| `process.open_file_descriptor.count` | gauge | {fd} | — |
| `nodejs.heap.used` / `nodejs.heap.total` | gauge | By | — |
| `nodejs.event_loop.utilization` | gauge | 1 | — |

### 4.3 宿主（卡顿的第二类原因）

| 指标 | 类型 | 单位 | 属性 | 来源 |
|---|---|---|---|---|
| `system.cpu.logical.count` | gauge | {cpu} | — | `os.cpus().length` |
| `system.cpu.utilization` | gauge | 1 | — | `os.cpus()` times 差分 |
| `system.load_average` | gauge | 1 | `window=1m\|5m\|15m` | `os.loadavg()` |
| `system.memory.usage` | gauge | By | `state=used\|free` | `os.totalmem/freemem` |
| `system.memory.limit` | gauge | By | — | `os.totalmem()` |
| `system.paging.usage` | gauge | By | `state=used\|free` | macOS `sysctl -n vm.swapusage` |
| `system.paging.operations` | counter | {op} | `type=major\|minor` | macOS `vm_stat` 的 pageins/pageouts |

> macOS 的 `os.freemem()` 会把可回收缓存算成「空」；`memory_pressure` 才接近人看到的
> 「可用内存」。所以 `state=free` 只作趋势，别拿绝对值当判据。swap / pageins 用异步
> `execFile` 每 10s 采一次（**禁止同步 IO**，见 `rule#async-io`）。

### 4.4 请求 / RPC / SSE

| 指标 | 类型 | 单位 | 属性 |
|---|---|---|---|
| `diy2.rpc.server.duration` | histogram | s | `rpc.method`、`rpc.status=ok\|error` |
| `diy2.rpc.server.active` | gauge | {req} | — |
| `diy2.http.server.duration` | histogram | s | `http.route`（白名单）、`http.status_code` |
| `diy2.sse.subscribers` | gauge | {conn} | — |
| `diy2.ws.connections` | gauge | {conn} | — |

`rpc.method` 用协议里已有的方法名（`rooms.list`、`chat.load` …），**不要**把 roomId / botId
拼进属性 —— 基数会炸，且属于用户数据。

### 4.5 业务慢点 / DB

| 指标 | 类型 | 单位 | 属性 |
|---|---|---|---|
| `diy2.op.duration` | histogram | s | `op`（现有 `timed` 的 label） |
| `diy2.db.query.duration` | histogram | s | `db.operation=all\|get\|run`、`db.table`（白名单） |
| `diy2.db.size` | gauge | By | `db.file=main\|wal\|shm` |
| `diy2.agent.turns.active` | gauge | {turn} | — |
| `diy2.agent.turns.total` | counter | {turn} | `outcome=done\|failed\|truncated\|interrupted` |
| `diy2.delivery.queue.depth` | gauge | {msg} | — |

`diy2.op.duration` 要**全量记录**，不能沿用「超过 100ms 才写日志」——直方图需要全样本才能算
p50/p99。慢日志继续保留，二者互补：指标发现「哪个 op 变慢」，日志给出「哪次、多慢」。

## 5. 采集点

1. **loop-lag**：`onSample` 记 histogram + gauge；`onLag` 记 `blocked` / `stalls` 两个 counter，
   属性 `verdict = cpuRatio >= 0.5 ? 'self' : 'starved'`。这是本次设计最重要的切分。
2. **timed / timedAsync**：在 `finally` 里 `histogram.record(ms/1000, {op})`，日志逻辑不变。
3. **RPC**：在 `apps/diy2/server/app.ts` 的 handler 注册处包一层（或给 `@diy-agent/rpc` 加
   `onDispatch` 钩子），记录 method / 状态 / 耗时；active 用 `upDownCounter` 或 begin/end 计数。
4. **HTTP**：`handle()` 入口按 route 白名单计时（`/api/info`、`/api/metrics`、静态资源分开）。
5. **DB（P2）**：`pkgs.ts/agent/entity-runtime/src/db.ts` 里把 `prepare()` 包成
   `prepareTimed(sql, { operation, table })`；先迁移热点查询（itemsOf、itemsByIds、
   lastItemsOf、failedByRoom、unreadByRoom），不要一次改 50 个调用点。
6. **宿主 sampler（P1）**：一个 5s 的 `setInterval(...).unref()` 读 os/process/v8；
   一个 10s 的异步 `execFile` 读 macOS swap / vm_stat。所有采集器都 try/catch，失败静默
   （监控不许把 app 带崩）。

## 6. 导出

### 6.1 依赖（已验证版本兼容）

```json
"@opentelemetry/sdk-metrics": "^3.1.1",
"@opentelemetry/exporter-prometheus": "^0.301.2",
"@opentelemetry/exporter-metrics-otlp-http": "^0.301.2"
```

同时把现有 `@opentelemetry/core` / `resources` / `sdk-logs` 对齐到 `3.1.1`，
用 `npm ls @opentelemetry/core` 确认只有一份。

### 6.2 装配层（唯一 import SDK 的地方）

```ts
// apps/diy2/server/metrics.ts（示意，非最终代码）
import { hostname } from 'node:os';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export function installMetrics(opts: {
    env: string;
    home: string;
    launch: string;
    mode: 'off' | 'prometheus' | 'otlp' | 'both';
}) {
    const resource = resourceFromAttributes({
        'service.name': 'diy2',
        'service.instance.id': `${hostname()}-${process.pid}-${Date.now()}`,
        'deployment.environment.name': opts.env,
        'diy2.home': opts.home,
        'diy2.launch': opts.launch,
    });

    const prom =
        opts.mode === 'prometheus' || opts.mode === 'both'
            ? new PrometheusExporter({
                  preventServerStart: true, // 复用 app 的 HTTP server
                  withoutScopeInfo: true, // 少一列 otel.scope.name
              })
            : undefined;

    const readers = [];
    if (prom !== undefined) readers.push(prom);
    if (opts.mode === 'otlp' || opts.mode === 'both') {
        readers.push(
            new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter(), // 读 OTEL_EXPORTER_OTLP_ENDPOINT
                exportIntervalMillis: 15_000,
            }),
        );
    }

    const provider = new MeterProvider({ resource, readers });
    metrics.setGlobalMeterProvider(provider);
    return {
        meter: provider.getMeter('diy2'),
        /** 挂到 `GET /metrics`；false 表示这次没开 Prometheus */
        scrape: prom ? (req, res) => prom.getMetricsRequestHandler(req, res) : undefined,
        shutdown: () => provider.shutdown(),
    };
}
```

`app.ts` 里：

```ts
if (req.method === 'GET' && url.pathname === '/metrics' && metricsScrape !== undefined) {
    metricsScrape(req, res);
    return;
}
```

`close()` 时 `await metricsShutdown()`（放在日志 flush 之前）。

### 6.3 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DIY2_METRICS` | `prometheus` | `off` / `prometheus` / `otlp` / `both` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | 设了才启用 OTLP（与 `DIY2_METRICS` 任一组合） |
| `DIY2_METRICS_INTERVAL_MS` | `15000` | OTLP 推送间隔 |
| `DIY2_HOST_METRICS` | `1` | macOS swap/vm_stat 采样开关 |

### 6.4 外部监控怎么接

**Prometheus（或兼容）直接抓 app：**

```yaml
scrape_configs:
  - job_name: diy2
    scrape_interval: 10s
    scrape_timeout: 8s
    static_configs:
      - targets: ['127.0.0.1:5192'] # app 实际端口
```

**Grafana Alloy / OTel Collector（app push，集中转发）：**

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  prometheus:
    endpoint: 0.0.0.0:9464
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

app 侧：`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 DIY2_METRICS=otlp`。

**其他 app**：Netdata / Uptime Kuma / VictoriaMetrics 都支持 Prometheus 文本 URL；
轻量脚本直接用现有 `/api/metrics` JSON，不必上抓取器。

### 6.5 机器级参数从哪来

- 本次 lab 的根因是 **内存不足 + swap**（16G 用满、swapout 1100 万、load 300），
  不是 app 代码。app 侧至少导出 load / CPU / memory / swap / pageins，才能把
  「卡了几秒」和「机器在干嘛」放进同一张图。
- 如果已有宿主机监控（Alloy / Netdata / node_exporter），**优先用它**，app 只补
  `diy2.*` 与进程级指标；两边通过 `host.name` / `service.instance.id` 关联。
- macOS 上 node_exporter 的 swap / memory pressure 支持不完整；需要精确值时用
  Alloy 的自定义脚本或本文的 app 内 sampler。

## 7. 查询与告警示例

```promql
# 1) 卡顿性质：CPU 占比与 lag 同图
max_over_time(diy2_event_loop_lag_max[5m])
avg_over_time(diy2_event_loop_cpu_ratio[5m])

# 2) 自己卡的累计时长（按分钟）
sum(rate(diy2_event_loop_blocked_total{verdict="self"}[10m]))

# 3) 被机器饿死的累计时长
sum(rate(diy2_event_loop_blocked_total{verdict="starved"}[10m]))

# 4) RPC p99（按方法）
histogram_quantile(
  0.99,
  sum by (le, rpc_method) (rate(diy2_rpc_server_duration_bucket[5m]))
)

# 5) 平均最慢的 op
topk(10,
  sum by (op) (rate(diy2_op_duration_sum[5m]))
  / sum by (op) (rate(diy2_op_duration_count[5m]))
)

# 6) 机器水位
avg_over_time(system_load_average{window="1m"}[5m]) / system_cpu_logical_count
system_paging_usage{state="used"}
```

告警：

```yaml
- alert: Diy2LoopStall
  expr: increase(diy2_event_loop_stalls_total[10m]) > 0
  for: 5m
  annotations:
    summary: 'diy2 事件循环卡顿（{{ $labels.instance }}）'

- alert: Diy2SelfBlocked
  expr: sum(rate(diy2_event_loop_blocked_total{verdict="self"}[10m])) > 0.05
  for: 5m
  annotations:
    summary: 'diy2 自己在算，查 op / DB / profile'

- alert: Diy2HostStarved
  expr: |
    avg_over_time(diy2_event_loop_cpu_ratio[5m]) < 0.3
    and max_over_time(diy2_event_loop_lag_max[5m]) > 0.5
  for: 2m
  annotations:
    summary: 'diy2 没抢到 CPU：查 load / swap / 其他进程'

- alert: Diy2ScrapeDown
  expr: up{job="diy2"} == 0
  for: 2m
  annotations:
    summary: 'diy2 连 /metrics 都答不上来 —— 可能整个进程卡死'
```

仪表盘建议四块：

1. **卡顿**：lag max + cpuRatio + load/核数（同一时间轴，直接看出蓝/红两色区）。
2. **慢点排行**：`diy2.op.duration` p99 与 `diy2.db.query.duration` 按表/操作。
3. **请求**：RPC/HTTP p99 + active + error rate。
4. **水位**：RSS、heap、swap used、pageins、file descriptors。

## 8. 基数 / 隐私 / 安全

- **禁用高基数标签**：roomId、botId、messageId、turnId、原始 SQL、URL path 参数一律不进属性。
- `db.table` 用白名单枚举；`rpc.method` 来自协议注册表；`http.route` 用路由模板而非原始 path。
- `/metrics` 与 `/api` 同端口、仅本机；如果将来通过反代暴露，必须加 token / 内网限制。
- 直方图桶边界固定，不允许按请求动态扩展属性。
- 不导出任何消息内容、模型凭据、key。

## 9. 分阶段

### P0（半天，先能看图）

- 安装 sdk-metrics + exporter-prometheus，对齐 otel 版本。
- `metrics.ts` + `GET /metrics` + `close()` flush。
- loop-lag 三项（lag histogram / lag.max、cpuRatio gauge / blocked counter）。
- `timed` 全量 histogram。
- 进程与宿主基础量（cpu、rss、heap、load、memory、eventLoopUtilization）。
- 验证：`curl /metrics | grep diy2_event_loop`；Prometheus 抓 `up==1`。

### P1（1 天）

- RPC / HTTP / SSE / WS 指标。
- macOS swap + pageins sampler。
- OTLP push 模式 + collector 配置示例。
- 告警规则与 Grafana 面板落成文件。

### P2（按需）

- DB 查询直方图（热点语句优先）。
- turns / delivery queue 业务指标。
- traces（`@opentelemetry/sdk-trace-node`）与慢日志 / profile 关联；
  exemplar 目前 `exporter-prometheus` 不序列化，暂不指望。

## 10. 已知坑

1. **进程卡死时 `/metrics` 也答不上来**：这是特性不是 bug。用外部 `up` / `scrape_duration_seconds`
   判断「完全卡死」，用 `diy2.event_loop.*` 判断「卡多久、什么性质」。
2. **counter 在重启后归零**：Prometheus 按 `increase/rate` 处理重启没问题，别用裸值告警。
3. **otel 包版本不一致会装两份 `core`**：统一到 3.1.1，并在 CI 加 `npm ls @opentelemetry/core` 检查。
4. **Prometheus 导出器不会把单位拼进名字**：名字里别写 `_ms` / `_seconds`，靠 `unit` 元数据；
   histogram 的 `le` 与样本值都按该单位（本文统一用秒）。
5. **高基数属性是自伤**：尤其 `db.statement` 与 `http.path`，一旦带上 id 就会把 Prometheus 打爆。
6. **不要用 `os.freemem()` 当「可用内存」**：macOS 会低估可回收内存；swap/pageins 更硬。
7. **同步 IO 禁令**：宿主 sampler 的 shell 命令必须异步 `execFile`；app 主进程不许读大文件同步。

## 11. 验收口径

- `curl -s 127.0.0.1:<port>/metrics` 能稳定返回，`target_info` 带 `service.name=diy2`。
- 人为制造一次 0.5s 同步阻塞（lab 后门 / 测试脚本）后：
  - `diy2_event_loop_blocked_total{verdict="self"}` 增加；
  - `diy2_event_loop_stalls_total` 增加；
  - 对应时段的 `cpuRatio` 明显高于 0.5。
- 人为把机器压满再触发同样操作：同一组 counter 的 `verdict` 变成 `starved`，
  `cpuRatio` 低、`system_load_average / system_cpu_logical_count` 高。
- `/metrics` 行数在压测前后保持同一量级（无基数爆炸）。
- 外部 Prometheus 能看到 `up == 1`；杀掉 app 后 `up == 0`。

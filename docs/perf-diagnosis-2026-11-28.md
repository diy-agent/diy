# diy2 性能调查结论（2026-11-28）

## 一句话结论

**卡顿有两笔账，不是一笔。** 稳态那笔已经查清并修掉了；启动期那笔（这次 5875ms）根因还没坐实，缺的是装配阶段的分段打点——不是缺猜测。

## 1. 稳态卡顿（已修，有实测）

| 项 | 修前 | 修后 |
|---|---|---|
| `turnLookup` | 272ms（全表 JSON 分组） | 11ms（点查 seek） |
| `failedByRoom` | 58ms | 21ms |
| `unreadByRoom` | 6.4ms | 0.4ms |
| `lastItemAtByRoom` | 9ms | 0.7ms |
| `rooms.list` 整段取数 | — | ~26ms |

**根因链**：`lastItemPerBot` / `lastFactPerTurn` 两条全表 `json` 分组在 43071 行 / 243MB 的库上各 ≈237ms，走 `items_author_seq` 全索引 SCAN（不能 seek）；TTL 5s 短于侧栏轮询 2.5s，于是大部分请求都撞上失效重算；`rooms.list` 后面还排着三条 160–200ms 的 `GROUP BY`。

**证据**：真库副本上的耗时打点 + 提交分支 `42-turn-lookup-seek`，单测 527+113 全过。

## 2. 启动期卡顿（这次 5875ms，未坐实）

历史 `stdout.log`（11-27 23:18）里的峰值：8359 / 5734 / 5696 / 4889 / 4173ms。关键观察：

- **lag 行早于 boot 行** —— 卡顿发生在 `createDiy2App()` 装配期，不是请求期；
- 当时还停在迁移页（`drop-unit-step` 未应用），所以稳态的那些 SQL 修复**不覆盖这段**；
- 日志里 `turnLookup` 的 slow 行（166–538ms）与 lag 峰值交错，但那只说明「装配里也调了这些查询」，**不能证明它就是 5875ms 的主因**。

**结论**：启动期同步重活是独立的第二条问题。要知道是谁占的，必须在装配阶段加分段打点（每个阶段一个 `timed`，落到日志与 `/api/metrics`），而不是继续从滞后的 lag 行反推。对应账本 `lag-boot`。

## 3. 观测手段（现状与本次完善）

修之前：主仓只有 `/api/metrics`（进程内 lag 快照，人读），**没有 Prometheus 文本出口、没有历史、没有请求耗时**。dev 仓的 VictoriaMetrics（`127.0.0.1:8428`）能抓，但主仓实例没有 `/metrics` 可供抓取——VM 里只有一个 lab 实例（`perf-attribution` worktree）的 series。

本次在分支 `42-perf-diagnose` 上把 `perf-attribution` worktree 里未提交的观测实现收拢进主仓线：

- `prom-metrics.ts` —— Prometheus 文本出口：lag（秒）/ blocked / stalls / CPU / load / RSS / 进程；
- `profile-watch.ts` —— 只在卡顿时落 CPU profile（谁在吃 CPU 有据可查）；
- **补 `diy2_http_request_duration_seconds` histogram** —— 按路由白名单记，状态分 2xx/4xx/5xx；原始 path 带 roomId/botId，绝不进指标（高基数）。这是原计划 §4.4 里写了但第一版没落的一项。

验证：`prom-metrics` 6 条 + `profile-watch` 6 条 + `loop-lag` 7 条单测通过（其中一条时间抖动用例单独重跑确认）。

### 怎么用

```bash
# 查最近两小时的 lag 峰值（VM 必须带 time）
curl -sG http://127.0.0.1:8428/api/v1/query_range \
  --data-urlencode 'query=max(diy2_event_loop_lag_max)' \
  --data-urlencode "start=$(($(date +%s)-7200))" --data-urlencode "end=$(date +%s)" --data-urlencode step=300

# 请求耗时 p99（按路由）
histogram_quantile(0.99, sum by (le, http_route) (rate(diy2_http_request_duration_seconds_bucket[5m])))
```

## 4. 还没做的

- `lag-boot`：装配阶段分段打点，坐实 5875ms 的主因；
- `dev-monitor-ui`：dev「监控」页已有 VM 状态/目标，但实时图表还没接；
- 请求耗时目前只覆盖 HTTP `handle()`，RPC / SSE 的单独计时还没分出来；
- 生产实例（`~/.diy2`，5192）仍是旧进程，没有 `/metrics`，要重启到带指标导出的构建才会进 VM。

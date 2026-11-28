# diy2 性能测试跑法与基线（2026-11-28）

## 为什么成文

以前查性能靠翻日志里滞后的 `[diy2:slow]` 行，同一句「卡了 5s」分不清是谁。现在指标出口齐了
（见 `perf-diagnosis-2026-11-28.md`），把**怎么测、看哪些数、基线是多少**固定下来，
下次改动前后各跑一次就能对比，不用重新摸索。

## 三档测试

### A. 稳态（进程跑起来之后的请求延迟）

前提：实例正在被 VM 抓（`up{worktree="..."} == 1`）。

1. 起一个实例（用真库副本，别用生产）：
   ```bash
   cd <diy 仓 worktree>
   node apps/diy2/bin/diy2 web --home /tmp/diy2-perf-lab --port 5194 --name perf-lab --launch lab
   ```
2. 让 dev 把 5194 加进 `build/metrics/targets.json`（label 带 `worktree`），VM 5s 内自动抓。
3. 打真实请求：用浏览器打开 `http://127.0.0.1:5194/` 几秒，触发 `rooms.list` / `chat.history` 等 RPC。
4. 查 p99（实例跑满 5 分钟后 `rate` 才有两个采样点）：
   ```promql
   histogram_quantile(0.99, sum by (le, op) (rate(diy2_op_duration_seconds_bucket{worktree="42-perf-diagnose"}[5m])))
   histogram_quantile(0.99, sum by (le, rpc_method) (rate(diy2_rpc_server_duration_seconds_bucket{worktree="42-perf-diagnose"}[5m])))
   ```
   刚起不到 5 分钟时用均值代替：`sum by (op) (..._sum) / sum by (op) (..._count)`。

**基线（真库副本 43071 行 / 243MB，修后）**：

| op | 修前 | 修后 |
|---|---|---|
| `turnLookup` | 272ms | 11ms |
| `rooms.list.failedByRoom` | 58ms | 21ms |
| `rooms.list.unreadByRoom` | 6.4ms | 0.4ms |
| `rooms.list.lastItemAtByRoom` | 9ms | 0.7ms |
| `rooms.list` 整段 | — | ~26ms |

**基线（全新空库，本次实测均值）**：四类 op 全部 < 1ms，`turnLookup` 0.2ms；RSS 97.5MB。
空库数字只用来确认「没有回归到几百毫秒」，不能当真库容量规划。

### B. 启动期（`createDiy2App` 装配阶段）

这次 5875ms 卡顿就发生在这里，**目前还缺分段打点**（账本 `lag-boot`），所以只能给判据不能给基线数字：

- 证据位置：`~/.diy2/log/stdout.log` 里 **lag 行早于 boot 行**的那一段。
- 历史峰值：8359 / 5734 / 5696 / 4889 / 4173ms。
- 跑法：清空日志 → 起实例 → 找 boot 行之前最后一条 lag 的毫秒数；分段打点做完后改看每段 `timed` 的 op 指标。

### C. 真库规模（容量对延迟的影响）

用生产库的**副本**（`cp ~/.diy2/diy2.db /tmp/...`），在上面跑 A 的整套。
`diy2_db_size_bytes{main}` 给出库大小，和 op p99 一起看，确认「行数涨了延迟没涨」。

## 看板（不用敲 PromQL）

打开 <http://127.0.0.1:8428/vmui/#/dashboards>，选「diy2 性能总览」，12 个面板分三组：

1. 事件循环：lag 峰值/p99、卡顿按性质（self/starved）、卡顿次数、CPU 墙钟比；
2. 延迟：HTTP / RPC / op 的 p99（按路由/方法/op）、HTTP 请求速率；
3. 资源：RSS、CPU 增速、系统负载、库文件大小。

dashboard 定义在 `dev` 仓 `pkgs/dev-core/dashboards/diy2-overview.json`，dev 启动时拷进
`build/metrics/dashboards` 并加 `-vmui.customDashboardsPath`，改 JSON 后重启 VM 生效。

## 判据（怎么算「性能没问题」）

- 稳态 op p99 < 50ms、`rooms.list` 整段 < 100ms（真库规模）；
- 启动期无 > 1s 的装配段卡顿（`lag-boot` 完成后按段判）；
- 卡顿的 `verdict`、`cpuRatio` 能对上：自己算的（self）有 CPU profile，被饿死的（starved）系统负载高。

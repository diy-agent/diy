# Agent 事件架构与压缩改造 · 开发计划

> 来源：2026-11-07 关于「事件订阅浪费 / Core actor / 聚合」的一系列讨论 +
> dsh 调研（`diy-research/pkgs.ts/agent-dsh/session/`）+ ##519 压缩点实测暴露的 bug。
> 本文只定**决策与分期**，实现细节随每期 PR 落。
>
> 首个落地对象选**压缩**，因为它是横跨「命令 / 事件 / 快照 / 持久化 / UI 投影」五层的最小闭环，
> 又是当前唯一已知有真 bug 的地方（压完面板不刷新、边界写没写看不出来）。

## 0. 一句话结论

**Command 表达意图，Event 表达事实，Snapshot 负责恢复；seq 由状态所有者（单一写者）分配；
UI 只持有本地投影，订阅按 (domain, resource) 合并，绝不让每个 View 各自建流。**

## 1. 五个已定决策

| # | 决策 | 理由 / 反例 |
|---|---|---|
| D1 | **seq 由一个「状态所有者」同步分配**，写入各 store 时回写 | 现网：`compact.setKept` 返回 `dropped: N` 但边界其实没写（`wrote:false`），界面照样报「已压」 |
| D2 | **命令返回回执**（`{commandId, accepted, seq, revision, error?}`），执行结果走事件流 | `send()` 直接返回 token 流 → 只适合 request/response，无法表达 job 通知、外部事件 |
| D3 | **一条事件信封**：`{eventId, source:{domain,id}, type, seq, ts, payload}` | 现在每条流形状不同，前端写多套解析 |
| D4 | **订阅分三层**：View 逻辑订阅 → Renderer 合并分发 → 一条物理流 → Core 网关 | `ops-feed` / `file-watcher` 的多订阅者各拿一份全量副本（`async-queue.ts` 头注释已写明） |
| D5 | **Summary / Detail 两层状态**：导航只要摘要，明细按需订阅 | 导航条与聊天页同时订阅同一份 ops 是当前最明显的浪费 |

不采纳：SQLite 事务（diy 立身之本是 jsonl 可读可重放）、独立 `CoreClient` 层（`api-def` 已 schema-first）、
新开第五份日志（现有 ops/turns/traffic/llm 足够，只需标注 replayable/transient）。

## 2. 目标形状（压缩先跑通）

```
UI（压缩点滑杆 / 轮次表 / 价格）
  │ ① 命令：compact.setKept { taskUri, keepRounds }  → 回执 { accepted, seq, revision }
  │ ② 订阅：agent.events.subscribe({ taskUri, afterSeq }) → 一条流（信封统一）
  ▼
main 单线程（单一写者）
  ├─ AgentState（每 task 一个）：seq 计数器 + 串行队列（SerialExecutor）
  ├─ 压缩命令：同步取 seq → 算边界 → 写 turns 账 + 回写 compact-state → 发事件
  └─ 事件网关：只把 domain 事件推给 UI（traffic / tool trace / 系统日志不在此通道）
```

**关键不变量**（加锁判据，测试要能守）：

1. 同一 task 的状态变更串行（`SerialExecutor` 每 task 一条队列）；
2. seq 在任何 `await` 之前同步分配；
3. 命令回执里的 `seq`/`revision` 之后，UI 一定能从订阅里补到 ≥ 该 seq 的事件；
4. 事件信封的 `seq` 单调递增，缺口即视为「需要重取快照」。

## 3. 分期

### P0 · 回执与真落盘（本周，纯修 bug）

- `compact.setKept` 返回值改为回执：`{commandId, accepted, seq, revision, error?}`；
  `accepted=false` 时带原因（无窗口 / 无可丢 / 边界未前进）。
- 每次真写边界都同步更新 `compact-state.json`（现在只写 turns 账，导致新进程读回 null）。
- UI：按钮状态由回执驱动；失败必须显示原因，不许静默「已压」。

**验收**：lab 里 4 轮会话压到 1 轮，重开面板轮次真的变 1；`grep` 只读 CLI 也能读到新边界。

### P1 · 事件信封 + 压缩事件流

- `api-def` 新增 `agent.events.subscribe({ taskUri, afterSeq? })` → 统一信封流。
- 事件类型（首批）：`compact.started` / `compact.committed` / `compact.rejected` / `turn.started` / `turn.ended`。
- durable / transient 标注：`compact.*` 与 `turn.*` 落盘（进 turns 账）；delta 类不落盘。

**验收**：一条流覆盖「压缩前后」，UI 不再 refetch 整个 ledger；事件里的 seq 与 turns 账一致。

### P2 · Renderer 侧订阅合并

- `SubscriptionManager`：按 `(domain, resource)` 引用计数，View 注册/注销只改动并集。
- `EventRouter`：一次接收，多 View 分发；共享不可变信封对象。
- 先接两处最浪费的：`ops-feed`、`file-watcher`。

**验收**：三个面板同时看同一会话时，物理流从 3 条降到 1 条（`traffic` 日志可数）。

### P3 · Summary / Detail 分层

- 导航条改用 `session.summary` 流（`{status, unread, updatedAt}`），不再订阅明细；
- 「当前会话」才订阅 `agent.events` 全量。

**验收**：关掉所有会话页，导航仍能显示运行中/未读状态；打开某个会话不额外新建流。

### P4（观察项）· 跨 domain 关联

- 需要因果时用 `correlationId`（例如「压缩事件」关联「触发它的用户命令」），**不引入全局 seq**。

## 4. 与现有代码的落点

| 需要改 | 位置 | 备注 |
|---|---|---|
| 串行队列 | 新 `main/core/serial-executor.ts`（约 40 行） | 可先只给压缩与回合收口用 |
| seq 计数器 | `LocalAgentManager` 每 task 一个；启动取 `max(turns.lastSeq, compact-state.lastSeq)` | 不新建文件，写进现有 turns 账行 |
| 回执 | `api-impl.ts` 的 `compact.*` handler | 返回结构变更，CLI 同步 |
| 事件网关 | 新 `main/services/event-gateway.ts` | 只对 UI 开放白名单 domain |
| 订阅合并 | 新 `renderer_solid/store/subscriptionManager.ts` | 先服务 `ops-feed` / `file-watcher` |
| 摘要 | `agent local running` 的活体表 + task 列表 | 复用现成数据，不新建投影服务 |

## 5. 风险与不做

- **不做**：分布式/跨机（Electron 单机，无断线重传需求）；Actor framework；SQLite；RxJS 当协议。
- **风险**：`compact-state.json` 与 turns 账双写不一致 → 以 turns 账为唯一真源，小文件只当缓存（现已有此约定）。
- **风险**：`seq` 与 `cut.llmLine`（ops 行号）两套坐标并存 → 明确分工：`seq` 管事件顺序，`cut` 管投递切片，
  两者用 `correlationId`（压缩事件 id）关联，不互相推导。

## 6. 讨论中形成的判断（备查）

- dsh 的 session 是**一份日志两条正交轴**（是否属于会话因果史 / 是否投影到请求），
  surface 是 core 闭集，插件只能写 `developer/message` 或走装配层。
- diy 把这份日志按轴切成 ops / turns / traffic / llm 四份，职责更清楚，
  代价是「会话史的时间顺序」要靠 join —— 本计划用 `seq` 把它补回来（不合并文件）。
- 压缩 = 命令（改边界）+ 事件（通知）+ 快照（可恢复）+ checkpoint 文本（模型可见的那条特殊消息）。

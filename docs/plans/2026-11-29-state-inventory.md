# 状态散落点清单（##43，2026-11-29）

用户判断：「感觉每次遇到状态机都可能有问题，是不是状态散乱到各处的缘故」。
这份清单先把**事实**摆出来：一共有几个状态型字段、各自谁写谁读、哪些是派生。

> 结论先给：**散的是「派生」，不是「真源」**。真源一共 7 个，都是表或内存里的单一字段；
> 问题出在同一件事有 2~3 处各自判一遍，判据一旦不同步就报假数（11-26 就真出过
> 「表格说出错、侧栏图标没事」）。所以改造方向不是「引进状态机库」，而是
> **让派生只走一个函数**，并把这件事写成测试（见 `sm-domain-test`）。

---

## 一、四层 × 七个真源

| 层 | 状态 | 值域 | 真源（唯一写入口） | 谁读 |
|---|---|---|---|---|
| **房间** | 开/关 | `open` / `closed` | `room.data.status`（`rooms.update`） | UI 的 `isClosed()`（唯一真源）；服务端**刻意不算**「关没关」 |
| 房间 | 投递 | `pending` / `working` / `delivered` / `failed` / `cancelled` | `deliveries.state`（`setDelivery`） | 排队数、失败标记、消息气泡上的状态、重发 |
| 房间 | 未读 | 水位 `read_seq` | `room_read`（`markRead`，只前进） | `unreadByRoom` → 侧栏蓝点 |
| 房间 | 提问 | `pending` / `answered` / `cancelled` / `expired` | `asks.state`（`AskGate.settleAsk`） | `pendingAsks` 计数、`AskCard`、... |
| **席位**（房间×角色） | 在跑 | `busy: boolean` | `session.busy`（内存） | `runningBots()` → 活动流、侧栏呼吸点、`BotRow.state` |
| 席位 | 轮次开着 | 一行/席位 | `turn_open`（`openTurn` / `closeTurn`） | `recover()` 判「上次没跑完」 |
| **轮次** | 结局 | `done` / `truncated` / `max-steps` / `filtered` / `tool-mismatch` / `failed` / `interrupted` | `end-reason.ts`（收尾时算一次） | `turn_facts`（结算行）、`turnLookup` → `BotRow.state`、`rooms.list.broken` |
| **实例** | 作业 | `running` / `done` / `failed` / `killed` | jobs 注册表（内存 + 产物目录） | 标题栏「后台任务 N」、抽屉 |

## 二、派生（这是「看着散」的地方）

| 派生值 | 从哪些真源算出来 | 算在哪 | 几处各判一遍 |
|---|---|---|---|
| `BotRow.state`（4 值） | `runningBots` + `pendingAskRequests` + `turnLookup().outcome` | `server/app.ts` 的 `botProfiles.rows` | 1 处（`BotStatusChip` 与 L3 表读同一份）✅ |
| `rooms.list.broken` | `turnLookup().outcome !== 'done'` | `rooms.list` | 1 处，与 `BotRow` **同源**（`turnOf`）✅ |
| `rooms.list.running` | `runningBots().length` | `rooms.list` | 与活动流同源（`running` 帧）✅ |
| `botProfiles.rows[].queued` | `deliveries.state='pending'` | `queuedByBot()` | 与 `rooms.list.queued` 同源 ✅ |
| `rooms.list.failed` | `deliveries.state='failed'`（按成员取最新一条） | `failedByRoom()` | 与 `deliveries.failed` 同源 ✅ |
| 标题栏「状态 N」 | `BotRow.state !== 'idle'` 的条数 | `bots.ts` 的 `needsYou` | 1 处 ✅ |
| 时间线气泡上的投递状态 | `deliveries` | `chat-core/timeline.ts` | 直接透传，不判 ✅ |

**判据收敛这件事 ##43 已经做过一轮**：`failedByRoom` 与 `deliveries.failed` 共用一个 SQL 事实、
`BotRow` 与 `broken` 共用 `turnOf`、`queued` 与席位的 `queued` 共用一个 `queuedByBot`。
现在没有「同一件事两份判据」的地方。

## 三、真正病过的地方（都已修）

| 病 | 症状 | 根因 | 修法 |
|---|---|---|---|
| `deliveries` 有第二维 `note` | `done` 同时表示「读完了」和「没送到」 | 11-27 把 5 状态压成 3 个时的权宜 | ##43：5 个状态直说，删 `note` |
| steer 失败丢消息 | bot 在跑时发话，偶尔既不回复也不报错 | `keepOnCancel` 恒 false（UI 无入口），fallback 永远走丢弃 | ##43：`requeue` 退回队列 |
| 恢复判「没送到」误报 | 好消息被标失败 | `textOf()` 只扫最近 200 条 | ##43：正文随投递存 + 精确查兜底 |
| 用户点停止后投递永久 `working` | 房间一直「有东西在跑」 | `cancel()` 只 `resolve()`，不写状态 | ##43：标 `cancelled` |
| 成员被删后投递永久 `pending` | 「排队 N」永不消失 | `recover()` 里 `continue` | ##43：标 `cancelled` |

## 四、还剩下的「多处判一遍」

只有一处值得记：**「在跑」有 3 个表达**

1. `session.busy`（真源，内存）
2. `ActivityFrame.rooms[].botIds`（活动流快照，1.5s 一推）
3. `rooms.list.running`（房间级数字，30s 一次）

三者都是「同一真源的快照，按新鲜度分档」，不是各自判断 —— 但**新鲜度不同步时会短暂不一致**
（用户 11-26 报过「在跑把上轮出错吞掉」，那是 `BotRow.state` 的优先级设计，不是这三个）。

结论：保留三档（各自有存在理由：内存判活、推送实时、轮询兜底），但**不要在第四处再算一遍**。

## 五、给 sm-plan 的输入

1. **不引 xstate**：真源只有 7 个、派生已收敛到单一函数；`delivery.ts` 那张手写状态图 +
   穷举测试就是「有限状态机」的等价物，xstate 6 还是 beta，换库收益 < 成本。
2. **要补的是测试**：现在投递线的行为靠散函数测试（`session.test.ts` / `room.test.ts`），
   没有一个「一句话讲清的场景」。`room-scenarios.ts` 是雏形，但只覆盖「结局与页脚」。
3. **状态图落点已定**（用户 2026-11-28）：贴代码（`protocol/delivery.ts` 文件头），
   不另立文档；本文件属于**一次性审计快照**，不随代码演进维护 —— 有冲突以代码为准。

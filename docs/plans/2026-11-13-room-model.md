# 词表与容器模型（Room / Bot / BotSession）

> 2026-11-13 · 定稿。之前 entity / bot / agent 三个词互相覆盖，这页是唯一口径。

## 三个词

| 词 | 是什么 | 有什么 | 没有什么 |
|---|---|---|---|
| **Room** | 会话容器。`type` 是**开放字符串**（`project` / `task` / `stock` / 任意），类型特有字段在 `data` 里 | 一条共享时间线、成员列表、默认应答 bot、目录等 type 数据 | 自己的 LLM 历史 |
| **Bot** | 身份（名字 / 颜色 / persona / 模型） | 可以被多个 room 借用；本身不执行 | 没有历史，不跑 step |
| **BotSession** | **bot 在某个 room 里的那条原生单线对话**（原 agent） | history / turn / step / 工具调用，自己的 seq | 不跨 room（A：per-room 隔离） |

一句话：**Room 是房间，Bot 是说话的人，BotSession 是这个人在这个房间里那条对话。**

`sessionId = roomId::botId`。同一个 bot 在两个房间 = 两条 BotSession，互不相识；
人格/模型改一次全房间生效（身份共享，历史隔离）。

## 已删掉的概念

| 删掉 | 原因 |
|---|---|
| `agent` 作为名词 | 被 `BotSession` 取代；"会跑 LLM 的东西"就是 bot（可以没有界面） |
| `Entity.kind` 枚举 | 换成 `Room.type` 开放字符串 + `data` |
| `dm`（bot 单聊） | 统一为 room，1~m 个成员即可；不再有 bot 一级列表 |
| `mode: single / meeting` | **由收件人决定**：1 个 = 单聊成本，k 个 = 开会成本；不落房间状态 |
| `owner` | 换成 `primaryBotId`（UI 文案「默认应答」）：没有 @ 时只有它说 |

## 开会怎么表达（没有 mode 字段）

```
say(text, recipients=[a, b])   ← 显式收件人（composer 选「全部成员」）
say(text)                      ← 缺省按 @ 规则：无 @ → primary；@name → 命中者；@all → 全体
```

- 收件人多 → 每个成员各跑一次 BotSession，token 成本直接可见；
- 每轮结束，各成员回复的最后一段 text（结论）作为 `next-turn` 消息追加到其他成员的 BotSession；
- 这就是"开会"的全部语义，不需要房间级开关，也不需要新的实体类型。

## 投递/队列的存储

一条消息 × 一个收件人 = 一行（1:n）：

```
messages(id, room_id, source, text, order_seq, at)
deliveries(room_id, message_id, bot_id, mode, state, claimed_at, updated_at)   ← 队列就是它的切片
inbox  = VIEW deliveries WHERE state='queued'
```

`mode` 只剩投递时机：`next-step`（默认，在 step 边界插入） / `next-turn`（等这一轮结束）。
system / job 只往 inbox 投事实，没有自己的 BotSession。

## 实现状态（2026-11-13 晚）

**已生效**

- `entity-runtime/src/session.ts`：`BotSession`，每 `(room, bot)` 一个，串行跑 turn；
- 两个投递时机用的是 AI SDK v7 原生 `experimental_createSteering()`：
  `steering.steer()` = **next-step**（工具批次结束后、下一次调模型前作为独立 user 消息追加，
  若本要收尾则多跑一步）；`steering.queue()` 语义对应 **next-turn**；
- 服务端 `POST /api/rooms/:id/chat` 默认 `next-step`，运行中再发就是插话；
  `POST /api/rooms/:id/cancel` 停止该房间所有会话（默认丢弃队列，`keepQueue` 保留）；
- 同一房间用房间级 SSE 广播：多个请求共享同一条事件流；
- 测试 `entity-runtime/tests/session.test.ts`（5 条）：空闲投递、运行中 next-step 不新开 turn、
  next-turn 排队、cancel 中止、cancel keepQueue 不丢。

**已知未做**

- `inbox` 表仍然没接：目前队列在内存（进程重启丢失），没做崩溃恢复与 `claimed` 回收；
- 多 bot 的"结论交叉投递"（开会）还没实现，只有 @ 激活一层；
- cancel 后未落盘的流式消息不会入库（刷新即丢）。

## 公共层与压缩（2026-11-13 深夜，已定稿实现）

### 两层，不是一个

| 层 | 内容 | 谁维护 | 压缩 |
|---|---|---|---|
| 房间日志 `RoomLog` | 人话 / bot 结论 / 通知，append-only | 房间 | **不压缩、不删除**（真相层） |
| BotSession 上下文 | 公共条目副本 + 自己的 tool/think/产出 | 每个 bot 自己 | **各压各的** |

关键更正：**没有"房间级水位"，也没有"共享 digest"**。之前设计里让某个 bot 的预算推进全局水位，
等于 a 的上下文压力决定 b 的记忆，已废弃。

### 条目 → 每个 bot 的视角

```
人话            → user:  原文
别人的结论      → user:  [名字 的结论] 正文     ← 只有结论，没有过程
自己的结论      → 不 ingest（已经在自己的 assistant 产出里）
通知            → 不进 session（UI 事件，进上下文只是噪音）
```

自己的 tool / reasoning **完整保留**在自己的 session 里（来自本轮的模型产出），
所以一个 bot 只有一条原生对话，不需要"两个 session"。

### 唤醒规则（结论不唤醒）

| 条目 | 所有人可见 | 唤醒 |
|---|---|---|
| 人话，无 @ | ✅ | primary |
| 人话，@x | ✅ | x |
| 人话，@all | ✅ | 全体 |
| bot 结论 | ✅（复制进其他 session，下一轮读到） | **无人** |
| bot 结论里 `@x` | ✅ | x（单人，@all 在 bot 侧忽略） |
| 通知 | ✅ | 无 |

### 时序

- 人话在跑的过程中到达：被 @ 的走 `steering.steer()`（下一步生效）；
  没被 @ 的进 pending，本轮结束后才并入上下文（下一轮读到）。
- bot 结论：本轮一结束就写日志并复制给其他 session，同样只进 pending。
- 同一轮内互相看不见 → 行为可预测，也不会乒乓。

### 压缩（`BotSession.compact`）

只在"自己即将开跑 + 超预算"时触发（`{ keepLast: 12, maxChars: 24000 }`）：

1. 折叠私有过程：丢掉 tool 消息、assistant 只留文本部分；
2. 还超预算：从最老的整条丢，前面留一句 `[更早的 N 条消息已折叠]`。

公共条目在第 1 步不动，只可能在第 2 步被整条丢弃。**压缩不产生公共产物，不通知任何人。**

### 验收（`entity-runtime/tests`，14 条）

- `room-log.test.ts`：seq 单调 / since、人话与结论的映射、自己的结论与通知不进上下文；
- `session.test.ts`：投递语义 5 条 + 自己的产出入账、ingest 不唤醒、运行中条目排在本轮之后、
  **压缩只压自己（b 的上下文一条不少）**、一轮结束报告结论。

### 内存版已知缺口

- 重启后 session 上下文清空（`seed` 钩子留着，未接 sqlite 回放）；
- 房间日志不落盘，重启重置；
- `inbox` 表仍未接（队列在内存，无崩溃恢复）。

## 压缩：可替换策略 + 可观测（2026-11-14）

### 算法与数据结构分离

```
BotSession  只负责：什么时候压（开跑前 / 手动）、压完记账、发事件
Compactor   只负责：怎么压（输入 entries + budget + usage，输出新 entries）
```

默认挂 `simpleCompactor`（确定性启发式，临时实验用）；将来接 `@diy-agent/compaction`
的 LLM 摘要版，session 一行不改。

**老库需要的数据结构**：`selectCompactableRange` 只要 `{ role, content, turn? }`，
`selectKeptBoundary` 只要 `{ tokens, user?, turn? }` —— **不需要 ChatMessage**。
所以没有重新设计，只补了唯一缺的东西：**每条消息的轮次归属**。

```ts
interface TranscriptEntry {
    message: ModelMessage;      // 原样保留（tool/reasoning 都在）
    origin: 'public' | 'self' | 'note';   // 谁能被折叠
    turn?: number;              // 切点吸附到轮首用
}
```

### 默认策略 `simple-fold-drop`

1. 折叠 `origin='self'` 的 tool 消息与纯工具调用的 assistant（公共层不动）；
2. 还超预算 → 从最老的**整轮**丢（切点落在轮首，工具对不会被拆开）；
3. 前面留一条 `[更早的 N 条消息已折叠]`（`origin='note'`，不参与折叠）。

### 可观测

- `SessionStats`：`entries / chars / collapsed / compactions / lastCompactAt / strategy / usage`
- `CompactEvent`：`before/after`（条数 + 字符）、`folded`、`dropped`、`summarized`、
  `durationMs`、`budget`、`usage`
- 控制台一行：`[compact] diy @proj:diy turn=40 simple-fold-drop 8msgs/674c → 5msgs/267c folded=2 dropped=4 0ms usage=522/10`
- `GET  /api/rooms/:id/sessions` → 每个 bot 的 stats + 最近 10 条压缩事件
- `POST /api/rooms/:id/sessions/:botId/compact { keepLast, maxChars }` → 手动压一次
  （只影响这个 bot，不触发运行；返回事件 + 新 stats）
- 预算可用环境变量临时改：`DIY2_COMPACT_CHARS` / `DIY2_COMPACT_KEEP`

实测：手动压 diy（maxChars=300, keepLast=2）→ `8msgs/674c → 5msgs/267c，folded=2 dropped=4`，
同一房间的 小满 保持 `8msgs/509c` 不变 —— 压缩确实只影响自己。

### 判据校准

`usage.inputTokens` 与 `stats.chars` 对照：中文 + JSON 结构下约 `chars ≈ 2 × tokens`。
所以 `maxChars = 24000` 大概对应 12k token 上下文，可按真实窗口再调。

## 压缩入口（UI，2026-11-14）

房间头部多了一个 `上下文 757 / 131.1k (1%)` 的 chip，点开是每个 bot 的上下文面板：

```
diy   5 条 · ≈381 tok                        [压缩]
      策略 simple-fold-drop · 压过 2 次 · 已折叠 4 条 · 上次 07:23 · 上轮实测 541 tok
小满  8 条 · ≈376 tok                        [压缩]
```

- 能看到：窗口大小（模型元数据）、当前估算占用、每个 bot 的条数 / 估算 token /
  压缩次数 / 累计丢弃条数 / 上次压缩时刻 / **上一轮实测 token**（用来校准估算）
- 能改：`保留 N 条`、`预算 M 字符`（默认取后端预算，改了只影响这一次手动压缩）
- 能压：单个 bot 的「压缩」或「全部压缩」，调 `POST /rooms/:id/sessions/:botId/compact`
- 结果就地显示：`diy：8 → 5 条（折叠 1，丢弃 4）`

估算口径：`token ≈ chars × 0.78`（diy2 实测 541 tok ↔ 697 chars）；面板同时显示
实测值，两者差太多说明估算需要调。

前端接线：`ChatClient` 增加**可选**的 `sessions()` / `compact()`，只有 HTTP 传输实现；
store 的 `actions.refreshSessions()` / `compactSession()` 负责拉取与触发。

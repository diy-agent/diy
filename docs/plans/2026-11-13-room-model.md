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

## Room 聚合根 + 成员模型（2026-11-14）

### 之前的问题

Room 只是一行配置（7 个字段，0 个方法），它的职责散在 server 的 7 个 Map 和一个 567 行文件里：
`sessionOf` / `route` / `publishConclusion` / `nextTurn` / `nextOrder` / `logOf` / `finish`。
`kernel.ts` 里还写着一份 `RoomActor` 契约，但没有任何代码 import 它。

### 现在

`entity-runtime/src/room.ts` → `RoomActor`（聚合根），独占：

| 职责 | 方法 |
|---|---|
| 成员与默认应答 | `members()` / `member()` / `primary()` / `setMembers()` / `addMember()` |
| 时间线 | `items()` / `deliveries()` / `entries()` |
| 发言与投递 | `say()` / `cancel()` |
| 会话池 | `sessionOf()`（私有）/ `sessionsInfo()` / `contextOf()` |
| 回合与顺序 | `turnFor()` / `nextOrder()`（私有，唯一分配点） |
| 路由（@ 规则） | `route()`（私有，唯一实现） |
| 结论发布 | `publishConclusion()`（私有） |
| 压缩 | `compact()` |
| 改名 / 换模型 | `update()` |

`apps/diy2/server/index.ts` 只剩 HTTP/SSE 适配（约 330 行，领域逻辑 0 行）。
`kernel.ts` 已删除 —— 被真实实现取代，不再保留第二份契约。

### 成员：RoomMember

```ts
interface RoomMember { botId; modelKey?; persona?; primary? }
```

- `Bot` 是全局身份（名字 / 颜色 / 归属），`RoomMember` 是它在这个房间里的面孔；
- 继承链 **成员 > 房间 > bot 自己**（`effectiveModelOf` / `effectivePersonaOf`）；
- 修掉了旧问题：UI 改房间模型只改 `room.modelKey`，而 bot 跑的是 `bot.modelKey` —— 现在房间模型真的生效。

### @ 规则只留一份

`protocol/src/room.ts` 的 `mentionsOf()`：路由、结论里的点名、前端补全共用。
（以前 server 里同一个正则抄了两遍。）

### 测试有了落点

`entity-runtime/tests/room.test.ts`（9 条，内存 sqlite + 脚本化 run，不碰 HTTP / 不碰真模型）：

- 无 @ → 只有默认应答；@名字 → 命中者；@all → 全员；显式 recipients → 开会
- 结论交叉：A 的结论进 B 的上下文、B 不被唤醒、角色是 user
- 运行中再发 → 沿用同一 turn
- 成员覆盖：模型 / 人格按 成员 > 房间 > bot
- cancel → 会话中止且投递标为 failed
- 新成员回放公共日志

## Session 事件化（2026-11-14，P3）

### 之前

`SessionDeps` 15 个字段，其中 5 个是房间职责（`nextTurn` / `nextOrder` / `onItem` /
`onDelivery` / `onTurnEnd`）—— session 知道房间怎么编号、怎么落库、怎么广播。

### 现在

```ts
interface SessionDeps {
    bot; modelKey;
    allocateTurn: () => Turn;      // 唯一必需的房间能力：借一个回合号
    seed?; run?; compactor?; budget?;   // 注入，测试用
}
```

session 只通过 `subscribe()` 输出事件：

```ts
type SessionEvent =
  | { type: 'item'; item: Item }                  // order 由房间补
  | { type: 'delivery'; messageId; state }        // 投递状态
  | { type: 'turn.end'; result: TurnResult }      // 房间据此写结论
  | { type: 'compact'; event: CompactEvent }      // 房间据此打日志
  | { type: 'error'; message }
```

房间侧 `onSessionEvent()` 负责：分配并固定 `order`（同一 item 的流式更新不再换序）、
落库（done/failed 去重）、广播、写结论、打压缩日志。

**边界变化**：session 不再产出 UI 之外的副作用；单独 new 一个 BotSession 就能测，
不需要造整个房间（`session.test.ts` 里加了断言：session 不分配 order）。

### 现在的依赖方向

```
protocol  ←  entity-runtime  ←  server
              (RoomActor 订阅 BotSession)
```

`RoomActor` 是唯一持有房间状态的对象；`BotSession` 是唯一持有对话记忆的对象；
两者之间只有「借回合号」一个同步调用，其余全是事件。

测试 37 条（room 9 / session 18 / room-log 4 / chat-core 6）。

## 持久化与崩溃恢复（2026-11-14，P4）

### 存了什么

| 表 | 内容 | 谁写 |
|---|---|---|
| `entity_items` | 展示时间线（done/failed） | Room（收到 item 事件时去重落库） |
| `deliveries` | 消息 × 成员的投递状态 + 入队信息（mode/turn/turnId） | Room |
| `room_entries` | 公共日志（人话 / 结论 / 通知，append-only） | Room（`appendEntry` 唯一写入口） |
| `session_state` | 每个 (room, bot) 的对话快照（turn / collapsed / entries / usage） | Room（每轮结束、每次压缩后） |
| `room_members` | 成员 + 本房间覆盖 | Room |
| `bots` | 全局身份 | server |

关键取舍：

- **session 存快照，不存 append-only**。压缩会就地折叠 tool 消息，用"前缀 + cutSeq"无法还原；
  快照（JSON 数组）简单、精确、可回放。代价是每轮重写一份，原型阶段可接受。
- **没有单独的 inbox 表**。队列 = `deliveries WHERE state IN ('queued','delivering')`，
  这正是最早设计里写的"inbox 就是 deliveries 的切片"。入队时把 `mode / turn / turnId` 一起写进
  delivery 行，重启后据此重新投递。

### 恢复流程（server 启动）

```
openStore
  → seed()：bot + 房间 spec + 成员
  → actorOf(spec)：RoomLog 从 room_entries 恢复；成员 session 从 session_state 恢复
  → actor.recover()：把 queued / delivering 的投递重新投一遍
```

`recover()` 把 `delivering` 也当未送达（进程可能是跑到一半挂的，模型回复本来就没落盘）；
找不到原文的投递标 `failed`，不静默丢。

### 实测

```
发「记住代号：蓝鲸 77」→ 重启服务 → 问「代号是什么」→ 答「蓝鲸 77」
重启后 diy 恢复 10 条上下文、小满 3 条；旧消息没有被重复投递
```

### 测试

`room.test.ts` 新增 2 条：

- 重启：同一个库新建 actor，公共日志条数一致、上下文含自己的回复、恢复本身不触发运行
- 崩溃恢复：手工造一条 `queued` 投递，`recover()` 后真的跑了一轮并置为 `delivered`

合计 39 条（room 11 / session 18 / room-log 4 / chat-core 6）。

## 工具层（2026-11-14）：从 @diy-agent/tools 移植

### 为什么移植而不是直接依赖

`@diy-agent/tools` 的 `main` 指向 `dist/`，而本仓的 build 图（`tsc -b build/tsconfig.build-all.json`）
在这个 worktree 上是有断链的（context → template → … 的 TS6305，以及 `makeShellTool` 的
TS2883 声明导出错误）。diy2 是 `tsx` 直跑源码，不能等 dist。

于是把**行为判据**移植过来，实现放在 `entity-runtime/src/tools/`：

| 工具 | 判据（与老包一致） |
|---|---|
| `read` | 带行号、offset/limit 续读、单次 200KB/2000 行；路径越界直接抛 |
| `write` | 整文件写、自动建父目录、返回行数变化；失败抛 |
| `edit` | 有序 edits、必须唯一命中（除非 `replaceAll`）、未命中抛 |
| `bash` | cwd = 房间目录；非零退出**返回结果**（退出码是数据）；spawn 失败抛；超时杀进程组并返回已收输出 |

统一约定：**工具失败抛异常**，不返回"失败字符串"——否则 SDK 会记成 done，UI 画 ✓ 且不展开。

工具结果的完整内容会进 transcript（这是"自己的过程要全套"的前提），压缩时按 `origin='self'` 折叠。

### 接线

```
server: cwdOf(spec)        // data.dir，任务继承所属项目的 dir
     → buildRoomTools({ cwd, shell, bashTimeoutMs })
     → RoomActorDeps.tools / toolsHint
     → BotSessionDeps.tools
     → runAgent({ tools })
```

`DIY2_TOOLS=files` 只开文件工具（关掉 bash）。

### 实测

- `read README.md` → 模型正确引用文件内容作答
- `bash pwd && ls` → cwd 是房间目录（`~/git/diy/diy`）
- `read ../../etc/passwd` → tool 失败（UI ✗），没有越界读取
- 两个 surface 都显示 `✓ Used tool: read`

### 测试

`entity-runtime/tests/tools.test.ts`（6 条）：读写回环、越界拒绝、edit 唯一命中 /
replaceAll / 未命中、bash 退出码与 cwd、bash 非零退出返回结果不抛。

合计 45 条（room 11 / session 18 / room-log 4 / chat-core 6 / tools 6）。

## 修：工具执行后消息不完整（2026-11-14）

**症状**：模型调了 9 次 bash，界面只剩一堆 `Used tool: bash`，没有文字结论。

**三个原因**（叠加）：

1. **步数上限太低**：`stopWhen: isStepCount(6)`，工具循环还没跑完就被掐断，
   模型拿不到机会输出最终文本 → 这一轮 empty text → 没有结论。
   现已**完全去掉上限**（`stopWhen: () => false`）—— AI SDK 缺省只跑 1 步，
   必须显式覆盖；唯一的刹车是用户点停止。
2. **文本没有分段**：一次 run 的所有 `text.delta` 都写进同一个 item，
   于是「说一段 → 调工具 → 再说一段」在时间线里变成「全部文本 + 一堆工具」，
   而且文本永远排在工具前面。现在每次 `tool.started` 会把当前文本段收尾，
   之后的文本是新的 item（`${messageId}#N`），时间线自然还原成 text → tool → text。
3. **server 没被类型检查**：`apps/diy2/tsconfig.json` 的 include 只有 `src/**/*`，
   `server/index.ts` 里的两个真错误（隐含 any / 缺 CompactEvent 导入）一直没被发现。
   已把 `server/**/*` 加进 include。

**测试**：`projection.test.ts` 4 条（分段 / 时间线交错 / 截断 notice / 不产生空气泡），
合计 49 条。

## 向用户提问（ask，2026-11-14）

> 早先做的"工具审批（允许/拒绝）"已废弃。用户的原话：**不需要审批，只需要提问** ——
> 遇到需要人决定的事，给选择题或表单，让人填；文字里问容易被大段输出淹掉。

### 模型侧：`ask` 工具

```ts
ask({
  question: '先做哪个？',
  kind: 'choice',                 // 有 fields 时缺省为 form
  options: [{ value, label, description? }],
  multiple?: boolean,
  fields?: [{ name, label, type: 'text'|'textarea'|'number', required? }],
  note?: '背景 / 影响 / 默认建议',
})
```

系统提示里写死：**需要用户做决定时必须调 ask，不要在正文里提问，也不要在正文里列选项。**

回答以文本回给模型：`用户选择：先做测试（test_first）` / `用户已填写：- 标题：…`。

### 界面侧

置顶卡片（`AskBar`，壳层，两种 surface 共用）：问题 + 说明 + 选项（radio / checkbox）
或表单字段；答完才消失，时间线留一条「已回答：A」。

### 传输

```
StreamEvent: { kind:'ask', request } | { kind:'ask.answered', askId, answer?/cancelled }
GET  /rooms/:id/asks          挂起中的提问（刷新恢复）
POST /rooms/:id/asks/:askId   { values } | { fields }
```

### 顺带补的一条：常驻事件流

之前 UI 只在 `post()` 期间订阅 SSE —— 于是"别处发起的提问"只能靠刷新快照看到，
回答之后的卡片也不会自己消失（实测踩到）。

现在 `ChatClient.watch()` + `GET /rooms/:id/events`：打开房间就挂一条常驻流，
后台 bot 的回复、提问、投递状态都能实时进来。`finish()` 只关"请求流"，不动常驻流。

### 闸门语义

- 缺省**不超时**（人可以慢慢想）；取消房间时 `cancelAll` 放掉，run 才能退出
- 刷新可恢复：`GET /rooms/:id/asks` 与 `load()` 的快照都带

## 测试分层（2026-11-14）

不写"按 HTTP 接口形状"的集成测试 —— 传输马上要换成 diy-rpc，锁在线上是浪费。

三层，各答一个问题：

| 层 | 文件 | 回答什么 | 依赖 |
|---|---|---|---|
| 领域 | `room.test.ts` / `session.test.ts` | 房间与会话的语义对不对 | 内存 sqlite + 脚本化 run，无网络 |
| 端口一致性 | `transport-conformance.test.ts` | UI 依赖的 `ChatClient` 契约有没有漂 | 同一套场景跑 N 个实现 |
| UI | 各 surface 的组件测试（待补） | 渲染与交互 | FakeChatClient，无网络 |

端口一致性用**参数化**跑同一份场景：

```
in-process   直接调 RoomActor，零网络
json-wire    同样的调用，但命令/事件都过一次 JSON（模拟序列化边界）
rpc          将来接 diy-rpc 时加一项，场景一条不改
```

`json-wire` 不是凑数：它专门抓"载荷里塞了不可序列化的东西"——那正是换传输才会炸的问题。
另有 `跨传输一致性` 一条：同一输入在两种传输下产出必须逐字段相同。

## 工具输出截断（2026-11-14）

照老方案（`@diy-agent/tools/shell/cap-output` + `@diy-agent/compaction` 的 `clipToolResult`），
只保留它的**核心判据**：

> **不在 execute 里裁。** execute 的返回值是原文（UI / 日志 / 审计看全量）；
> 只裁"发给模型的那一份"。

落地位置是 transcript 入账处（`agent.ts` 的 `onStepTranscript` → `clipModelMessage`）：

```
头 80 行 + 尾 20 行 + marker（省略多少行 / 共多少字符 / 怎么重取）
单行 > 500 字符先截行
整体 > 12000 字符再按字符头尾兜底
未超限逐字符不变（不做归一，避免无谓的缓存失效）
```

实测（`seq 1 20000`，约 118KB）：

```
UI 的 tool 条目       118583 字节（完整）
transcript 里的那条   459 字符（头尾 + marker）
```

老库还会把原文落盘并在 marker 里给 resume 路径；diy2 暂不落盘，marker 提示模型
用 `read` 的 offset 或缩小命令输出重取。等需要"字节保真"时再接落盘。

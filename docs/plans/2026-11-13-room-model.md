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

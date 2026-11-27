# Room 只是容器，Bot 才是主体 —— 边界重划与概念收敛（2026-11-27）

> 起点是一句质疑：「RoomActor 没有任何阻塞行为，真正的 IO 在 bot 的对话上；room 充其量是个
> 容器，room 的状态只是内部对象状态的聚合表现 —— 现在好像是 room 自己来做 turn 的串行管理？」
>
> 查完代码：**串行其实在 bot 的 session 里，room 只发号**。但质疑指向的真问题成立 ——
> **room 越界成了 bot 的宿主，并且缓存了本该由 bot 独占的运行态**。
> 本文定边界、砍概念，然后按 4 个可独立合并的阶段落地。

---

## 1. 现在什么毛病（都是用户能看见的）

| 症状 | 现场 | 根因 |
|---|---|---|
| **报出不存在的排队** | 连发 3 条、bot 正在跑 → 面板写「2 条消息排队中」，其实那 2 条就在这一轮里跑 | `pump()` 一次取空队列（`session.ts:557`），但 `queuedByBot()` 只减 1（`room.ts:606`） |
| **有时能插话、有时只能排队** | 同样「bot 在跑」，有时你的话立刻被看到，有时要等整轮 | `steering` 在 `runTurn` 第 659 行才创建，而 `compact()` 在第 633 行 —— 压缩期间 `running=true` 但插不进去 |
| **「在跑」标记和实际不同步** | 侧栏显示在跑、房间里却在排队（2026-11-26 报过） | 「在跑」被存了三份：`session.running` / `room.speaking`（Set）/ `deliveries.state` |

三个症状、一个病根：**同一件事存了三份，谁也没法单独说真话。**

---

## 2. 概念清点：现在 14 个，目标 6 个

| 现在的概念 | 是什么 | 处置 |
|---|---|---|
| `queued` / `delivering` / `delivered` / `failed` / `skipped` | 一条消息的投递状态，**5 个值** | → **3 个**：`pending` / `working` / `done`（失败并入 `done` + `error`） |
| `next-step` / `next-turn` | 投递方式：插进当前轮 / 等下一轮 | → 删。换成消息来源 `human` / `system`，见 §5 |
| `session.queue` + `session.running` + `session.steering` | bot 自己的运行态 | **保留**（这是 bot 的事） |
| `room.speaking`（Set） | `session.running` 的副本 | **删**，改成问 session |
| `room.turnStarts`（Map） | session 的轮次起点副本 | **删**，从 `turn.end` 事件取 |
| `room.compacting`（Map） | bot 的压缩 controller | **删**，归 BotSession |
| `room.contexts`（Map） | bot 的提示上下文 | **删**，归 BotSession |
| `pendingResolvers`（数组） | steer 路径的 resolve 暂存 | **删**，steer 成功即 resolve |
| `keepOnCancel`（布尔） | cancel 与 post 之间的悬挂标志 | **删**，改成 `cancel(keepQueue)` 的调用参数 |

留下来的 6 个：**Message / Delivery(pending·working·done) / Turn / Session / Room / Bot**。

---

## 3. 目标模型（一屏讲完）

```
Room（容器：不跑东西，只管"这个房间里有什么、发生过什么"）
  ├─ log       消息与事件的日志（唯一持久状态）
  ├─ members   bot 的配置（不是运行态）
  ├─ turnSeq   发号器（同步计数器；@all 时所有 bot 共享一个号）
  ├─ gate      提问闸门（跨 bot 的生命周期协调，唯一确实需要房间级的东西）
  └─ 聚合查询  running / waiting —— 每次都问 bot，不缓存

Bot（主体：有 IO、有生命周期）
  ├─ queue / running / steering    自己的队列，自己一轮一轮跑（串行在这里）
  ├─ transcript / compacting       自己的对话与压缩
  ├─ context                       自己的提示上下文
  └─ 对外：post() / cancel() / snapshot() / 事件
```

**判据（写代码时的尺子）**：

- room 里出现 `await`，只能是在**等 bot**，不能是自己做事；
- room 里出现 `Map<botId, …>` 存 bot 的**运行态**，就是越界（成员配置、日志条目不算）；
- 同一件事只允许一个写入者。投递状态**只有 BotSession 写**，room 只转发事件。

---

## 4. 消息的生命周期（3 个状态）

```
        post()
          │
          ▼
     ┌─────────┐   bot 开始处理它   ┌───────────┐   跑完   ┌──────┐
     │ pending │ ─────────────────► │  working  │ ───────► │ done │
     └─────────┘                    └───────────┘          └──────┘
          ▲                                                      │
          └───────────── cancel(keepQueue) 退回队列 ─────────────┘
```

- **pending** —— 消息在库里，bot 还没开始处理。UI 只数这个 = 「N 条等着」。
- **working** —— bot 正在处理它（无论是插进当前轮，还是作为本轮的第一条）。
- **done** —— 处理完了；`error` 有值就是失败（含被跳过）。

**为什么要合并**：`delivering` 现在同时表示「正在插进当前轮」和「已被取出正在跑」，
UI 于是必须拿另一个状态的副本去修正（`queuedByBot` 的减一、`RoomStatusBar` 的
`!live.has(botId)`）—— 一处写错就报假数。合成 `working` 之后，这两处判断都可以删掉。

---

## 5. 插话不再是概念

现在对外暴露 `mode: 'next-step' | 'next-turn'`，用户要理解「插话 / 排队」两条路。
但它本质上是**发送者的身份**决定的：

| 谁发的 | 期望 |
|---|---|
| 人 | 趁 bot 还在跑就让它知道；万一并进不去，等下一轮也行 |
| 系统（job 结束 / 别的 bot 的结论） | 永远别插到半句话中间 |

所以 `mode` 换成 `kind: 'human' | 'system'`：

```ts
post(message, { kind: 'human' })   // 能并入当前轮就并，不能就排下一轮 —— 调用方不管
post(message, { kind: 'system' })  // 永远等下一轮
```

**"插话"这个能力还在**（ai-sdk 的 steering），但它变成 bot 内部的实现细节：
人发的消息如果当前轮还没进入模型调用，就并进去；否则进队列。**UI 和调用方都不需要知道。**

---

## 6. 搬迁表

| 现在住在 | 东西 | 搬到 | 阶段 |
|---|---|---|---|
| `room.speaking` | 谁在跑（Set） | 删；`runningBots()` 改成遍历 `sessions.values()` 问 `running` | P1 |
| `room.turnStarts` | 轮次起点（Map） | 删；UI 用 `turn.end` 事件里的 `startedAt/endedAt` | P1 |
| `room.compacting` | 压缩 controller | `BotSession` 内部 | P1 |
| `room.contexts` | 提示上下文 | `BotSession` 内部（构造时传，不再回查） | P1 |
| `deliveries.state` 5 值 | 投递状态 | 3 值（`pending`/`working`/`done`）+ `error` | P2 |
| `queuedByBot()` 的减一 | 排队数 | 直接数 `pending`（无修正） | P2 |
| `session.pendingResolvers` | steer 的 resolve 暂存 | 删；steer 成功立即 resolve | P3 |
| `session.keepOnCancel` | 悬挂布尔 | `cancel(keepQueue)` 参数贯穿 | P3 |
| `mode: next-step/next-turn` | 投递方式 | `kind: human/system` | P3 |

---

## 7. 四个阶段（每阶段独立可合、可验证）

### P1 —— 删缓存态（不动 db，不动对外契约）

- 删 `speaking` / `turnStarts` / `compacting` / `contexts` 四处 Map
- `runningBots()` 改成问 session
- **验收**：`@all` + 连发 3 条，面板不再出现「2 条排队」；侧栏「在跑」与 `turn.start` 一致

### P2 —— 投递状态收敛成 3 个（动 db，带迁移）

- `deliveries.state`：`queued→pending`、`delivering→working`、`delivered/done→done`、
  `failed/skipped→done + error`
- 迁移：启动时按旧值批量改（一次性 SQL，幂等）
- `queuedByBot()` 改成 `countByState('pending')`，删掉减一
- **验收**：`sqlite3 … "select state,count(*) from deliveries group by state"` 只剩 3 个值；
  面板排队数 = 库里 pending 数

### P3 —— 插话变成内部细节

- `mode` → `kind`；`pendingResolvers` / `keepOnCancel` 删掉
- `steering` 创建提到 `runTurn` 第一行（压缩之前）
- **验收**：压缩期间发消息也能并入当前轮；`await room.say()` 在消息被处理时立刻 resolve

### P4 —— turn 发号与 session 解耦（继续向"容器"收）

- `newTurn()` 保持同步发号，但**调用方**从 session 改成 room.say（一条用户消息发一个号）
- 删 `QueueItem.turn`（每条消息不再自带 turn，合并轮的 turn 由发号时定）
- **验收**：@all 时 3 个 bot 的 `turnId` 完全相同；连发 2 条不再出现「一轮里有两条不同 turn」

---

## 8. 数据迁移（P2 的一次性 SQL）

```sql
UPDATE deliveries SET state='pending'  WHERE state='queued';
UPDATE deliveries SET state='working'  WHERE state='delivering';
UPDATE deliveries SET state='done'     WHERE state IN ('delivered','done');
UPDATE deliveries SET state='done', note=COALESCE(note,'failed')
                   WHERE state IN ('failed','skipped');
```

启动时跑一次（`schema_version` 记账，幂等）。

**旧客户端兼容**：`diy2` 是自部署的，前端与后端一起发版，不做双版本兼容 —— 但 db 迁移必须
能回滚（`state` 是文本列，反着改回去即可）。

---

## 9. 明确不做

- **不把 room 改成无状态的纯投影** —— 它得持有 log 和发号器；"容器"不等于"无状态"。
- **不合并 Room 与 Bot** —— bot 有 IO 与生命周期，room 没有；合并只会造出更大的上帝对象。
- **不动 `ask` 闸门**（`AskGate`）—— 它确实是房间级的跨 bot 协调，留在 room 是对的。
- **不动压缩算法** —— 只搬 controller 的归属，不改压缩策略。
- **不为兼容留双份状态** —— 用户要的是"少概念"，同时存在新旧两套字段比原来更糟。

---

## 10. 判据回顾（改完拿这三条扫一遍）

1. **一个写入者**：任何状态只有一个地方写。`deliveries.state` 只有 `BotSession` 写。
2. **room 不缓存**：`RoomActor` 里 `Map<botId, …>` 只能是「配置」或「日志」，不能是运行态。
3. **一屏讲完**：新人问「一条消息怎么被处理」，答得出来三个状态 + 一个队列，就算过。

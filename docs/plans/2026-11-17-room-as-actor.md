# Room / task / project 怎么套 actor 内核（diy2 实证）

> 2026-11-17 · 回答「每个 task、每个项目都是一个 actor，怎么套到 `@diy-agent/actor` 上」。
> 证据来自代码阅读（路径 + 行号），未跑的部分会标出来。前置文档：
> `2026-11-13-room-model.md`（词表与容器模型）、`2026-11-12-diy2-alignment.md`（拍板）。

---

## 0. 结论先行

1. **不是一个 room 一个 actor，是一个 room 一个容器 actor + 每个 (room, bot) 一个会话 actor。**
   `project` / `task` / `stock` 只是 `room.type`，走同一个 `RoomActor` —— 所以「每个任务一个 actor」
   和「每个项目一个 actor」是同一句话，不需要两套机制。
2. **套内核的真问题不是「怎么包」，是「串行链里放什么」。**
   `actor()` 的链只装**毫秒级状态变更**；LLM 一轮（几十秒）必须在链外跑，跑完回链上提交。
   diy2 现在就违反了这条：`RoomActor.say()` 会 `await` 到整轮结束（`room.ts:178` 的
   `await Promise.all(recipients.map(b => session.post(...)))`），房间被钉死一整轮。
3. **跨 actor 可以 await，条件是「被调方法不等任何后续事件」**。
   一旦「我调你、你等我的回调才算完」，必须换成 tell + 事件回报。diy2 里唯一真正的环是
   `SessionDeps.allocateTurn`（session → 房间），而这个环**已经可以删掉**（`say` 时就把 turn 传下去了）。
4. **task 与 project 不是父子 actor，是平级两个 actor + 一次性快照**。
   现在 `cwdOf()` 会去 `rooms` 里 `find` 父 actor 读 `data.dir`（`apps/diy2/server/index.ts:105`）——
   这是跨 actor 的隐式共享，应该在**创建 task 时把解析后的 dir 写进自己的 spec**。
5. **内核缺的都在外层，且只缺两件**：`registry`（roomId → actor，懒建 + evict + 恢复）和
   `idempotency`（客户端 `commandId` → receipt）。这两件都不该进 184 行的内核。

---

## 1. diy2 现状：哪儿已经是 actor，哪儿不是

| 位置 | 现在是什么 | 距 actor 差什么 |
| --- | --- | --- |
| `entity-runtime/src/room.ts` `class RoomActor`（750 行） | 聚合根：成员 / 公共日志 / turn·order 分配 / 路由 / 投递表 / ask 闸门 | 没有串行链（靠 JS 同步段 + 不变量）；`say()` await 整轮 |
| `entity-runtime/src/session.ts` `class BotSession`（586 行） | 自己的队列 + `pump()` + AI SDK steering + 压缩 + 事件出口 | 队列是**执行队列**不是状态链；不是 actor |
| `entity-runtime/src/db.ts` | `node:sqlite`：rooms / items / deliveries / room_entries / session_state / drafts | 已经是 actor 该有的持久化层 |
| `apps/diy2/server/index.ts`（746 行） | `Map<roomId, RoomActor>` + `actorOf()`（懒建）+ `recover()` + SSE 广播 | 就是 registry，但没有 evict / 幂等 / 归档 |
| `agent/bot/src/aggregate.ts`（547 行） | 另一套 agent：`send/post/cancel/compact → Receipt`、`subscribe(afterSeq)`、`SerialExecutor` | 形状已经对了，但没有被 diy2 用；与 entity-runtime 是两份实现 |
| `pkgs.ts/room`（920 行） | 纯内核：成员 + @ 解析 + 水位增量投递 + `RoomStore` 端口，零 task、零 IO | 是 diy2 这条路线的「理论版」，尚未接线 |
| `core/actor`（内核 184 + cmd 188） | `serial()` / `actor()` / `cmd()` / `implement()` / `serveActor()` / `createActorClient()` | **仓库里零使用者**（`grep @diy-agent/actor` 只有自己） |

顺带一个数字：**手写串行现在有 4 份** —— `chat.ts:205 createSerial`、`aggregate.ts:170
SerialExecutor`、`pkgs.ts/room` 的 `enqueue/chains`（`room.ts:280`）、`session.ts:345 pump`。
前三个是同一件东西（状态互斥），第四个不是（执行队列）。内核统一的是前三个。

---

## 2. 映射：身份、层级、地址

### 2.1 actor 的身份就是 roomId，`type` 不是身份

```
Room { id, type, name, data, members, modelKey }     // protocol/src/types.ts:28
  proj:diy      type='project'  data={ dir: '~/git/diy/diy' }
  task:t-001    type='task'     data={ dir, projectId: 'proj:diy', status: 'doing' }
```

一个 `RoomActor` 服务两者（`apps/diy2/server/index.ts:116` 的 `actorOf(spec)` 不看 `type`）。
`type` 只影响三件事：`data` 的解释、UI 图标、默认成员数。**所以「每任务一 actor / 每项目一 actor」
是同一张注册表，不是两套对象。** 这是把问题简化掉的一半。

### 2.2 每个 room 是 1 + N 个 actor

```
RoomActor(roomId)                       ← 容器：成员表、公共日志、turn/order、路由、投递表
  ├─ BotSessionActor(roomId, botId)     ← 参与关系（拍板 6「借用即分身」）
  ├─ BotSessionActor(roomId, botId2)
  └─ …
Bot                                     ← 纯数据，不是 actor
```

- `Bot`（名字 / 颜色 / persona / modelKey / homeRoomId）**不能**是 actor：改一次人格要跨
  「bot actor + N 个成员 actor」做事务，而它变一次要全房间立刻生效 —— 它是**查表数据**。
- `BotSessionActor` 的地址是二元组 `(roomId, botId)`，即 `sessionId = roomId::botId`。
  「bot 被借用」= 同一份身份数据被多个 session actor 读到，**不是** actor 嵌套/克隆。
- 为什么必须两级：一条房间消息要并发叫醒 k 个 bot（`say` 的 `Promise.all`），而每个 bot 有自己的
  上下文、自己的压缩、自己的 steering。「房间一条链」会把 k 个 bot 串起来跑（k=3 时一条消息
  从 20s 变 60s）；「只有 session 没有房间」则没人分配 turn/order、没人管路由。

### 2.3 依赖方向必须是无环的

```
        （短命令：post / cancel / compact / ingest）
RoomActor ───────────────────────────────────────▶ BotSessionActor
    ▲                                                    │
    └────────── 事件（item / delivery / turn.end）────────┘

现在多出来的一条（要删）：BotSessionActor ──allocateTurn()──▶ RoomActor   // session.ts:60
```

`allocateTurn` 是唯一一个「子调父」的同步调用，而 `say()` 现在**已经**把 `turn` 传下去了
（`room.ts:224` 之后 `post({ messageId, text, mode, turn, entry })`）。所以它只剩一个兜底分支
（`session.ts:364` `items[0]?.turn ?? this.deps.allocateTurn()`），删掉它就得到一张严格的 DAG。

---

## 3. 套内核的四条硬约束

### ① 串行链 ≠ 执行队列

`actor()` 的 `chain.send()` 每次只该跑「读状态 → 算 → 写状态 → emit」，**不能 `await` 长任务**：

```ts
// ✗ 现在的形状：房间链被 LLM 钉死，cancel 排不进去
async say(input) { … await Promise.all(recipients.map(b => this.sessionOf(b).post(…))) }

// ✓ 链内只记账 + tell，立刻返回回执
say(input) {
    const turn = this.turnFor(input);          // 同步分配，唯一分配点
    const item = this.store.appendItem(…);     // 同步落库
    this.emit({ kind: 'item', item });          // 链内同步 emit（见 ③）
    for (const bot of recipients) {
        const delivery = this.store.setDelivery({ state: 'queued', … });
        tell(this.sessionOf(bot).post({ turn, entry, … }));   // 不等
    }
    return { accepted: true, itemId: item.id, turn, recipients };
}
```

`session.pump()` 是**链外的执行体**，跑完用 `chain.send(commit)` 回链上提交（写结论、落
session_state、发 `turn.end`）。这样 `cancel()` 永远排得进去 —— 这是现在 diy2 靠
`AbortController` 绕过队列才做到的事，actor 化后就是理所当然。

### ② 跨 actor 可以 await，但不许等对方的回调

精确判据（比「禁止跨 actor await」好使）：

> 可以 `await` —— 被调方法只做本地状态变更后立刻返回。
> 必须 tell —— 被调方法的完成要依赖**另一个 actor 的后续事件**。

按这条看 diy2：

| 调用 | 判据 | 结论 |
| --- | --- | --- |
| `room.say()` → `session.post()` | 现在等整轮结束 | **改 tell**（回执 = delivery 状态） |
| `session` → `room.allocateTurn()` | 子调父，父在等子 | **删**（turn 随 post 传入） |
| `room.cancel()` → `session.cancel()` | 立刻返回 | 可 await |
| `room.compact()` → `session.compact()` | 压缩可能调 LLM 摘要 | tell + `compact` 事件回报 |
| `session` → `room`（`emit`） | 事件不是调用，不等待 | 链内同步调用 |

### ③ 事件必须在链内同步 emit

事件顺序 = 提交顺序，靠的就是「emit 发生在链内、`await` 之前」。diy2 已经是这个形状
（`room.ts:207` 落库后立刻 `this.deps.emit(...)`），套内核时**不要把 emit 挪到 async 尾**。
另外 `emit` 的接收方（SSE `broadcast`）要包 try/catch：一个断掉的 socket 不该让 `say()` reject。

### ④ 必须有幂等键

actor 化 + tell + 断线重连（diy2 已有 `ready → reload()` 补拉，`room-model.md`「常驻事件流」）
⇒ 重发是常态。现在 `messageId` 是服务端生成的（`u-${now}-${order+1}`，`room.ts:196`），
客户端重试会造出两条。改造成本很低：`say({ commandId, … })`，房间侧
`Map<commandId, Receipt>` 命中即返回原回执（`aggregate.ts:145` 已经是这个形状，抄过来）。

---

## 4. task / project 的语义（不是父子 actor）

| 关系 | 现在 | actor 化之后 |
| --- | --- | --- |
| task 的 dir 继承 project | `cwdOf()` 去 `rooms` Map 里 find 父 actor | **创建 task 时解析并写进 `task.data.dir`**（快照），此后 task actor 不认识 project |
| project 的默认模型 / 人格 | `effectiveModelOf(member, room, bot)` 纯函数 | 不变（纯函数），但结果在写 spec 时算好 |
| project 删掉时级联 task | `store.deleteRoom` 只删一个 id，级联由 server 决定（`db.ts:51`） | 由 registry 做：`close` 子 actor → 删库。**不跨 actor 事务** |
| task 完成 | `data.status` | `RoomActor.archive()` → 之后 `say()` 返回 `accepted:false, reason:'archived'`，上下文保留只读 |
| task 数量 = actor 数量 | 全部懒建后**永不释放**（`rooms` Map 只增） | 必须 evict（见 ⑤） |

一句话：**task 是「有生命周期的容器」，project 是「长驻容器」，差别只在 registry 的策略，不在类型系统。**

### ⑤ registry 必须能 evict（否则「每个 task 一个 actor」不可行）

```
ensure(roomId): CmdActor<RoomApi>     // 懒建：rooms 表 → spec → actorOf(implement(...)) → recover()
evict(roomId)                          // idle() && 无订阅 && 无 queued delivery && 空闲 > N 分钟 → close() + 删 Map
pin(roomId) / unpin(roomId)            // project 常驻；task 只在打开时驻留
```

两个坑，都是这次能提前避免的：

1. **`close()` 杀不掉链外的东西**。`actor.close()` 只 abort `life.signal` 和后续调用；
   `session.pump()` 是链外的 async 循环，如果它没监听 `life.signal`，evict 一个正在跑 LLM 的
   session actor 之后 pump 还在跑、还在 emit → 幽灵消息。要求：pump 的 `AbortController`
   必须从 `life.signal` 派生（`AbortSignal.any([life.signal, own])`）。
2. **evict 不是「挂起」**：状态在 sqlite，重建只是再 `recover()` 一遍（diy2 实测重启恢复
   ~几十 ms，`room-model.md`「持久化与崩溃恢复」）。所以 registry 不需要「唤醒」逻辑，
   只需要「销毁 + 下次重建正确」。

---

## 5. 套上去之后长什么样（骨架）

```ts
// room.api.ts —— 客户端可 import，零实现（cmd 的全部好处就在这里）
export const roomApi = {
    say: cmd({ input: z.object({ text: z.string(), author, commandId: z.string(), recipients: z.array(z.string()).optional(), mode: z.enum(['next-step', 'next-turn']).optional() }), output: z.custom<Receipt>() }),
    cancel: cmd({ input: z.object({ botId: z.string().optional(), keepQueue: z.boolean().optional() }), output: z.custom<Receipt>() }),
    snapshot: cmd({ input: z.object({}), output: z.custom<RoomSnapshot>() }),
    items: cmd({ input: z.object({ afterOrder: z.number().optional() }), output: z.array(z.custom<Item>()) }),
    answerAsk: cmd({ input: z.object({ askId: z.string(), answer: z.custom<AskAnswer>() }), output: z.custom<Receipt>() }),
    compact: cmd({ input: z.object({ botId: z.string(), keepLast: z.number().optional(), maxChars: z.number().optional() }), output: z.custom<CompactEvent | null>() }),
    archive: cmd({ input: z.object({}), output: z.custom<Receipt>() }),
};

// room.impl.ts —— 只在服务端，可以 import node:sqlite / node:fs
export function roomImpl(spec: Room, deps: RoomActorDeps) {
    return actorOf(implement(roomApi, (life) => new RoomState(spec, deps, life), {
        say(s, input) { return s.say(input); },        // 链内：记账 + tell，立刻返回
        snapshot(s) { return s.snapshot(); },           // 读也排队 → 一定看得见之前的所有写
        // …
    }));
}
```

三个「套内核时会硌一下」的地方，先说清楚：

1. **`ActorOf<M>` 会把所有方法 Promise 化**，包括读（`items()` / `members()`）。现在
   `RoomActor` 的 `spec` 是 getter，参数里到处 `actor.spec`（`cwdOf`）。改法：只暴露
   `snapshot(): RoomSnapshot`，别暴露 getter。diy2 的调用点很少（`cwdOf` / `broadcast`），
   而且 `cwdOf` 按 §4 应该挪到「创建时」。
2. **`actorOf` 这个名字已经被 `apps/diy2/server/index.ts:116` 占了**（roomId → RoomActor）。
   `cmd` 里也叫 `actorOf`（`CmdImpl → CmdActor`）。改名前先定：registry 的入口叫
   `ensure(roomId)`，`actorOf` 留给 cmd。
3. **`class` + `private` 方法要拆成「闭包 state + 公开 handler 表」**。`RoomActor` 的私有
   方法（`route` / `publishConclusion` / `nextOrder` / `sessionOf`）在 actor 里就是 store 上的
   普通函数，不上面方法表 —— 这跟 `examples/02-room` 里「内部调 push，不走 api」是同一条规矩。

---

## 6. 迁移顺序（每步都有验收，不改领域语义）

| 步 | 做什么 | 验收 |
| --- | --- | --- |
| 1 | `BotSession` 包成 `BotSessionActor`：方法表 = `post/ingest/cancel/compact/stats`；`post` 契约从「等本轮结束」改成「立刻 accepted」；`turn.end` 走事件 | `session.test.ts` 18 条全绿（只改等待点，不改语义）；新增一条：`post()` 在 LLM 未结束时 < 10ms 返回 |
| 2 | 删 `SessionDeps.allocateTurn`，`say()` 必传 turn | 37 条事件断言不变；`grep allocateTurn` = 0 |
| 3 | `RoomActor` 包成 `RoomActor`（cmd）：`say/cancel/snapshot/answerAsk/compact`；`say` 返回 receipt | `room.test.ts` 11 条全绿；新增：`say()` 期间并发 `cancel()` 能被处理（现在靠 abort 绕过） |
| 4 | registry：`ensure/evict/pin/recover`；`say` 幂等表 | 新建 task → 打开 → 空闲 evict → 再打开，上下文完好；同一 `commandId` 发两次只落一条 item |
| 5 | server 换成 `serveActor` + `createActorClient`（`subscribe` 单独一条事件流，不是 cmd） | `transport-conformance.test.ts` 三种实现（in-process / json-wire / rpc）逐字段一致 |
| 6 | task 生命周期：`archive()`、`data.dir` 快照、级联删除走 registry | 归档的房间 `say` 被拒且原因可见；删 project 后 task actor 已 close |

基线：**diy2 现有 45 条测试是这次改造唯一的行为判据**（room 11 / session 18 / room-log 4 /
chat-core 6 / tools 6）。actor 化只改「调用的形状」，任何一条变红都说明改的是语义，不是形状。

---

## 7. 判据清单（写代码时对一眼）

- [ ] actor 的方法里没有 `await` 任何 LLM / 磁盘大 IO（只有同步状态变更 + 立刻返回）
- [ ] 每个 `emit` 在链内、在 `await` 之前
- [ ] 跨 actor 的每个 `await` 都能答出「它为什么不会等对方的回调」
- [ ] 每个会改状态的外部命令都有 `commandId`（幂等）
- [ ] 每个 actor 都能 `close()` 且链外的东西（pump / timer / SSE）都跟着停
- [ ] 没有任何 actor 从另一个 actor 读数据（要读就在创建时快照）
- [ ] `type`（project/task）不出现在 actor 的实现里，只出现在 registry 策略和 UI

## 8. 还开放的两件事（需要拍板）

1. **两套 agent 实现留谁**：`entity-runtime/session.ts`（AI SDK + steering + 压缩，diy2 在用）
   vs `bot/aggregate.ts`（命令 + 回执 + `subscribe(afterSeq)`，形状更 actor）。
   倾向：**保留 session.ts 的行为，抄 aggregate 的契约形状**（Receipt / commandId / subscribe），
   然后把 aggregate 标退役 —— 否则 actor 化之后仓库里有两个 `Receipt` 定义。
2. **`pkgs.ts/room` 这套纯内核还要不要接**：它已经解决了 diy2 现在手写的「水位增量投递 +
   `skipped` 语义」（`room.ts` 的 `planDelivery`），但它的 `post()` 是 `AsyncGenerator<RoomEvent>`
   —— 那是「方法等结果」，跟 §3① 冲突。要接就得把它也改成 receipt + 事件。

---

## 9. 收尾（2026-11-17：actor 开发到此暂停，diy2 不迁）

**结论：`@diy-agent/actor` 保持现状（内核 184 行 + `cmd` 188 行 + 八个范例），不再扩设计，
也不迁 diy2。** 等真有「第二个进程同时写同一份状态」或「按 command log 重放」的需求再接。

### 不迁的理由（一句话版）

内核保护的是**多写者竞争 + 位置透明**，而 diy2 的对话是**单写者 + 长任务**：

- `say()` 的状态变更（turn 分配、order、`appendItem`、`emit`、`appendEntry`、`setDelivery`）
  **全在同步段**，一次 `await` 都没跨过（`room.ts:178-240`）—— 11-02 文档里那个「b3 丢了」
  的窗口在这条路径上不存在；
- `pump()` 的 `if (this.running) return`（`session.ts:345`）已经是一执行体单飞；
- 唯一的真窗口是「`say()` 在 `await Promise.all(post)` 期间被第二个 `say()` 重入」，
  而修法只有一条 —— 把 await 移出状态段（30 行），移完串行不变量自动成立，
  `serial()` 变成一句「已经为真的断言」。

代价侧：2000 行成熟代码 + 45 条测试重排，用户可见收益为零，而内核当时零使用者 ——
让框架的第一次实战和业务重构绑在一起，出错时分不清是谁的错。

### §8 两问拍死

1. **留 `entity-runtime/session.ts`**（diy2 在用，45 条测试是基线）；`bot/aggregate.ts` 标退役，
   代码暂不删。它的三个契约形状（`Receipt` / `commandId` / `subscribe(afterSeq)`）可以单独
   抄进 session —— **不需要 actor**。
2. **`pkgs.ts/room` 不接**。它是理论原型，`post()` 返回 `AsyncGenerator` 与 §3① 冲突；
   留作「水位增量投递 + `skipped` 语义」的参考实现。

命名口径：registry 入口叫 `ensure(roomId)`，`actorOf` 留给 `cmd` 子路径（`CmdImpl → CmdActor`）。

### 仍然独立成立的三件小事（不依赖 actor，随时可做）

| # | 改什么 | 为什么 |
|---|---|---|
| 1 | `say()` 不 `await` 整轮（`room.ts:232` → `tell`） | 房间不再被钉死一轮；`cancel` 不必再靠 `AbortController` 绕过队列；`/chat` SSE 不必等整轮才收尾 |
| 2 | 入参加 `commandId`（幂等） | 现在 `messageId` 服务端生成，重发就多一条 item |
| 3 | `cwdOf()` 别 `find` 父 room（`server/index.ts:105`） | 创建 task 时把解析后的 `data.dir` 快照进 spec，去掉跨聚合的隐式读 |

### 真要接时的顺序（照 §6，只走前两步）

1. `BotSession` 包 actor，`post` 改成「立刻 accepted」→ `session.test.ts` 18 条全绿；
2. 删 `SessionDeps.allocateTurn`，`say()` 必传 turn → 37 条事件断言不变。

**不碰 `server/index.ts` 的 registry**。这两步就是把「链里放什么」改对；
连它们都过不了 45 条基线的话，说明问题不在 actor，停手是对的。

### 内核边界（设计如此，不是缺陷）

registry / evict、幂等键、生命周期树、跨 actor 事件、命令日志重放 —— **都在外层**。
`close()` 只停内核的链；链外执行体（LLM pump / timer / SSE）必须自己从 `life.signal` 派生，
否则 actor 关了它还在 emit。这条已写进包 README 的「状态」一节。

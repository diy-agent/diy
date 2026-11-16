# 待办：ask 卡片上的「取消本轮」撤不掉提问

日期：2026-11-16
状态：**G1 已修（含「通知不该叫醒」）**；G2 / G3 仍开着
修复：撤销 = `AskGate.cancel(askId)` → `RoomActor.cancelAsk()` → `POST /api/rooms/:id/asks/:askId/cancel`，
卡片按钮「取消本轮」改成「撤掉这一问」
现场：diy2 实例 5192，房间 `task:t-001`，ask `ask-mwj8lf4k-1`（19:05 提问，挂了 3 小时仍 pending）

## 现象

「任务树与多会话」任务里最后一条提问，点卡片上的「取消本轮」什么都不发生，卡片和按钮原样留着，看起来像状态卡住。

## 判定：不是状态坏了，是这个按钮在该语境没有对应动作

链路：`AskCard.tsx:246` → `conversationOf(roomId).cancel()` → `POST /api/rooms/:id/cancel` → `room.cancel()`

- `room.ts:279` `cancel()` 只 abort 正在跑的 session。注释明写：「不动待回答的提问。ask 不阻塞，点『停止』时那一轮早就跑完了，卡片还得留在界面上等用户作答。」
- ask 不阻塞（`ask.ts` 头注）：模型问完 → 工具立刻返回回执 → 本轮结束、流关闭。**卡片只是留言板**，不持有任何在执行的东西。
- 房间此刻没有 session 在跑 → 服务端 no-op；就算有，被 abort 的也是正在生成的 bot，不是这张卡。
- `AskGate` 没有单条取消的能力：只有 `cancelAll()`（`ask.ts:176`）/ `cancelFor(owner)`（`ask.ts:183`）。**「撤掉某一问」后端目前做不到。**

## 顺带查出的三个缺口

### G1 卡片按钮与它所处的状态不匹配

pending 卡片常出现在"房间早已空闲"的时候，此时「取消本轮」必然 no-op。缺一个「撤回提问」。

修法（已实现）：`POST /api/rooms/:id/asks/:askId/cancel` → `AskGate.cancel(askId)`（cancelled + 理由「提问已被撤回」）→ 复用淘汰路径的 `notifyOwner` 告知提问的模型；卡片收尾成「已失效：提问已被撤回」。卡片上的按钮直接改成「撤掉这一问」，不再给一个在此语境必然 no-op 的「取消本轮」。

### G1-b 通知不能变成叫醒（修 G1 时发现，已一并修）

上一轮给淘汰加的通知走了 `say()` → `post()`，而**给一个空闲成员 post 就是真的跑一整轮**。实测：B 先问一个→空闲，A 连问 21 个挤掉 B 的 → 运行变成 `[bot:b#1, bot:a#1, bot:b#2]`，多出来那轮只为读一句「不用再等」。

修法：`say({ quiet: true })` —— 落时间线（UI 可见）+ `ingest` 进所有人上下文，但不投给任何人、不叫醒。撤销与淘汰两条通知都走它。反向验证：去掉 `quiet` 后 D8 立刻红在 `[bot:b#1, bot:a#1, bot:b#2]`。

### G2 `done` 事件清空 `speaking`，撤的是别人的"执行中"

`store.ts:100` 对 cancel 也先 `emit({ running: true })`；cancel 的收尾是 `done`，`reduce.ts:119` 处理成 `{ running: false, speaking: [] }`。多会话房间里点某张卡片的「取消本轮」，会把别的还在跑的 bot 的「执行中」抹掉，等服务端下一条 `running` 事件才回来。

### G3 5192 那条 ask 没有 `owner`

`GET /asks` 的 JSON 里无 `owner` 字段。源码是传的（`room.ts:508` `askOwner: botId`），但 5192 跑的是 17:14 打的 `build/prod`、17:51 启动，早于该版本。无 owner → 回答投给 primary 成员，多会话里可能投错人。**任何改动都要重新 build/prod 才会到 5192。**

## 设计选择，不是 bug

`timeoutMs` 缺省 0 = 提问永不过期。所以一条 bot 早已跑完的提问可以长期挂着。（与 P2-5「pending 全在内存」同源：重启会丢，长期挂着倒也算一种"没丢"。）

## 参考

- 合并 review 与已修项见 `docs/plans/2026-11-16-ask-async-merge-review.md`
- 本轮已合入 main 的相关改动：淘汰时告知模型（`notifyOwner`）、独立卡片不被误挂「执行中」

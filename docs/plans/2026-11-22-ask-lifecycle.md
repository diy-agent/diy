# ask 的寿命与未结指引（2026-11-22）

## 起因（用户报的两件）

1. 导航树上有 `?`，但进会话不知道**是哪个**提问 —— 卡片挂在触发它的那一轮里，几轮之后沉底。
2. 「一个 bot 是不是只允许一个遗留问题？skip 之后再问一组是不是太多？」

第二问的实测答案：**skip 从来不产生遗留**（按题 `skipped: true` 整批结算）。遗留之所以会累积，是因为
提问**永不过期**：`room.ts` 建 `AskGate` 时没传 `timeoutMs`（缺省 0 = 一直等），而 `MAX_PENDING = 20`
只是「撑到 20 张才挤掉最旧」的数量兜底 —— 前 19 张全是僵尸。

## 从别家核实到什么（不是拍脑袋）

| 说法 | 核实 |
|---|---|
| codex `tool/requestUserInput` + `autoResolutionMs`，turn 起止清理未答请求 | 无源码，**未核实**；但它与我们最终采用的规则同构，当参考 |
| OpenAI Agents SDK `needsApproval` → interruption → resume RunState | 未核实；属 Approval 层，我们没有 |
| LangGraph `interrupt()` + checkpoint + resume | 未核实；它要「恢复执行栈」，我们明确不做（run 状态全在 transcript） |
| 「如果你说的 DSH 是 Dify」 | **错**。dsh = deepseek-harness（`~/git-ref/deepseek-harness`）：`ask_user_question` 是 timed wait → 超时返回 pending、卡片转 `continued`、迟到答案走 steer 变成一条新消息 —— **与 diy 同构**，最值得抄的一家 |
| ChatGPT 普通提问「不阻塞」 | 半对：它是把问题写进正文、该轮结束。没有结构化 Question 对象，没有多未结可借鉴 |
| opencode 阻塞 + composer dock 一次一个 | 已核实 |

（另：那篇把 Question / Approval / Gate / Interrupt / Checkpoint 分开，这条是对的，也是 diy 的做法 ——
`ask.ts` 头部一直写明「与审批的区别」，将来做工具授权也不许复用 ask。）

## 结论：寿命规则

> 未结提问的寿命 = 它所依赖的世界状态的寿命 = **到提问者开启下一个 turn 为止**。

问的不是「几个」，而是「什么时候到期」。diy 里世界状态换代的时刻是可判的：`BotSession.runTurn` 开头
（那一轮已经读到新消息、可能已经重新提问）。由此：

- 同一 turn 内再问一次 → 后者**取代**前者（同一批决策的更新，不是两个并存的待办）
- 下一 turn 再问 → 旧的已**过期**（它依赖的状态没了）
- ⇒ **每成员同时最多 1 张未结**，是规则的结果，不是人为设的上限
- 房间层面可以有 N 张（N 个成员各一张）—— 多 bot 会议本来就该有几个人在等你回话
- `MAX_PENDING = 20` 退化成安全网（只对 `owner` 缺省的调用有意义）

过期与「作废」要分开说：作废=这问不算数了；过期=**它没等这个答案，已经继续工作了**。

## 落地

| 改动 | 位置 |
|---|---|
| `turn.start` 事件（一次 busy 可含多轮，`busy: true` 不能替代） | `entity-runtime/src/session.ts` |
| `AskGate.expireFor(owner, reason)` + `request()` 里的同成员取代 + `expired` 落库（`state='expired'`） | `entity-runtime/src/ask.ts`、`db.ts` |
| `turn.start` → 过期；`settleAsk` 落 `expired`；通知措辞区分「过期 / 作废」 | `entity-runtime/src/room.ts` |
| 卡片说「已过期（…）：提问者没等这个答案，已经继续工作了」；根节点带 `data-ask-id` | `entity-chat/components/AskCard.tsx`、`chat-core/timeline.ts`、`projection.ts`、`reduce.ts` |
| 顶部常驻「等你回答 · N」+ 题目 chip，点了 `reveal` 扩窗 + `scrollIntoView` + 闪一下 | `entity-chat/components/PendingAskBar.tsx`、`ChatPanel.tsx`、`useWindowed.ts` |
| 侧栏 `?` 的 tooltip 带题干（`diy2.rooms.list` 新增投影字段 `pendingAskTitles`） | `apps/diy2/server/app.ts`、`entity-chat/store.tsx`、`RoomRow.tsx` |

## 刻意不做

- **不把待答卡搬进 composer dock**：opencode / dsh 那样做是因为它们的提问阻塞 run，卡片是那个 run 的唯一出口。
  diy 的提问不阻塞，卡片属于「当时那一轮」，搬走会和上下文脱节 —— 补入口比搬走对。
- **不做 Approval / Gate / Checkpoint**：我们没有需要暂停的动作（工具早就跑完了），也不做执行栈恢复。
- **不给待答条加 sticky**：它在线程滚动区外面，本来就不跟着滚。

## 代价（已知）

- 用户「随口插一句」也会让提问过期。所以过期必须**留痕**（卡片 + 时间线一句系统说明）并**通知提问者**
  （`notifyOwner`，quiet：不叫醒）—— 模型据此决定要不要重新问，用户看到的是「它没等我」而不是卡片凭空消失。
- 过期通知进的是**房间公共日志**：安静通知只是不叫醒人，不是私聊，别的成员也会读到（多 bot 房间的已知噪音）。

## 验收

- `AskGate`：同成员取代、`expireFor` 只动目标成员、过期不能再答、`answeredList` 带 `expired`
- 房间级：插话 → 提问过期（留痕 + 通知 + 不能再答）；21 连问塌成 1 张；跨成员互不挤；重启后过期卡仍在
- 纯函数：`pendingAskHintOf` / `askChipOf` / `askChipTitleOf`

# ask 不阻塞 + 已答卡片：合并前 review

日期：2026-11-16
范围：当前工作区全部未提交改动（`git status` 里 45 个修改 + 20 个未跟踪）。
问题：**实现中的逻辑错误有哪些，能不能合并到 main。**

## 0. 结论

- **ask 主线逻辑成立**：不阻塞之后每个 tool call 仍拿到 result，回答落库成用户消息并在模型下一轮可读，刷新能恢复已答卡片。
- **但整个工作区不能一次合并到 main**：里面混着 5 组互不相干的改动，且另一路会话正在同时写同一批文件（第一次跑测试有 4 条红，几分钟后全绿，红全在它正在写的新套件里）。
- 合并前要处理 2 个 P0、2 个 P1。都很小（改键、加兜底、改一行返回值）。

### 现状核对

| 项 | 结果 |
| --- | --- |
| 全仓测试 | 456 passed / 1 failed |
| 唯一失败 | `@diy-agent/log` otel 日志文件名（测试目录里留着旧的 `2026-10-31.log`，与本次无关） |
| `tsc --noEmit` | 各包干净（`tsconfig.all.json` 尾逗号是老问题，tsc 容忍） |
| 并发风险 | `end-reason.ts` / `stop-scenarios.ts` / `room-scenarios.ts` / `EndFooterLine.tsx` / `stops.*` 正被另一路写入 |

## 1. 逻辑错误

### P0-1 页脚只按 `turnId` 存，多 bot 同轮串台（已实测复现）

- `pkgs.ts/ui/chat-core/src/reduce.ts:85`：事件带 `botId`，reducer 丢掉它，只做 `turnEnds[turnId] = reason`。
- `pkgs.ts/ui/chat-core/src/timeline.ts:304/313`：`attachEndReasons` 按 `endReasons[turnId]` 给每个 bot 的最后一段赋同一个结局。
- 后果：房内两 bot 用 `@all` 同轮跑，A 被截断、B 正常说完 → A 的页脚显示 B 的结局。临时用例输出 `A: interrupted, B: interrupted`（A 真实是 `max-tokens`）。
- 旁证：新样本 `both-fail-differently`（两只 bot 停得不一样）正在争这件事。
- 修法：key 用 `` `${turnId}\0${botId}` ``，`reduce` 与 `attachEndReasons` 同步改。

### P0-2 回答投给已离开的成员 → 静默黑洞（已实测复现）

- `pkgs.ts/agent/entity-runtime/src/room.ts:341-348`：`settleAsk` 用 `say({ recipients: [owner] })` 投回答。
- `route()` 是 `participants.filter(...)`；成员被移除后 recipients 为空 → 回答照常落库成用户消息、**没有任何 bot 收到、也不报错**。实测：

  ```
  human items: ['动手吧', '回答提问「选哪个？」：\nA（a）']
  deliveries: ['bot:a:delivered']   ← 只有提问前那条，回答没有新投递
  ```

- 相关：`AskGate.cancelFor`（`src/ask.ts:152`）**已无任何生产调用点**（只剩单测）。`cancel()` 改成"不动 pending"之后，成员被移除时既不取消提问也不改投 → 卡片永久无效却仍在显示。
- 修法（择一）：`setMembers` 里对移出成员 `cancelFor`；或 `settleAsk` 在 owner 不可投时回退 primary。

### P1-3 `settleAsk` 吞掉投递失败

- `src/room.ts:348`：`void this.say({...}).catch(() => undefined)`。
- `say` 在"房间没有 bot"时会抛。吞完之后：用户看到自己已回答、时间线上有一条消息、没人理、没提示。
- 修法：至少落一条 error 条目（或把卡片标失效）。

### P1-4 文字题空回答拼出无答案的消息

- `src/ask.ts:51`：`if (request.kind === 'text') return answer.text?.trim() ?? '（空）'` —— 空串不是 `undefined`，返回 `''`，投出去是 `回答提问「…」：` 后面什么都没有。
- UI（`AskCard` 的 `ready`）拦住了这条路径，API 直连会走到。
- 修法：先 trim 再判空。

### P2-5 pending / answered 全在内存

- `AskGate.KEEP = 50`（`src/ask.ts:91`）；pending 无上限也无回收（`timeoutMs` 缺省 0 = 永久）。
- 以前 ask 阻塞时重启丢卡片只是"这轮早结束了"；**现在它是唯一通道**：卡片丢了 = 这条提问永远答不了，而 transcript 里还留着"我问了"。
- 刷新能恢复（快照带 `answeredAsks`），重启不能。合 main 前建议补 `room_asks` 落库，或重启时把未答提问转一条 notice（"该提问已失效"）。

### P2-6 已答卡片会借别人的消息挂载

- `timeline.ts:212`：找不到 `tool-${toolCallId}` 就退到"最后一条 assistant 条目"。
- pending 时合理（工具条目还在流式、未落库）；但已答卡片可能是几百条之前的事，一旦那条工具行不在窗口里（history 截断 / 将来分页），卡片会跑到时间线底部且看不出属于哪一轮。
- 建议：显式给了 `toolCallId` 却找不到时，挂成独立卡片（或渲染成"原消息已不在窗口内"），不要借用别人的消息。

### P2-7 其他

- `maxOutputTokensOf` 在 `session.runTurn` 和 `runAgent` 各算一遍（现在幂等，两层逻辑将来会漂）。
- `reduce` 里 `answered` 只增不减（服务端 50 条封顶，前端不封顶）。

## 2. 核对过、没问题的部分

- ask 不阻塞后，**每个 tool call 仍有 result**（回执），provider 侧硬约束未破。
- 回答落库为 `human` 消息；`room.ts` 的缺省 `human:我` 与 `apps/diy2/server/index.ts:34` 的 `HUMAN` 一致，模型侧读到 `回答提问「…」：…`。
- 取消本轮不再废掉 pending 提问；只有 `stop()`（删容器）才清空且不投递回答。
- 刷新后已答卡片能恢复；只读态没有提交路径，不会撞 404。
- 插话续段（`continued`）只改渲染，不改条目独立性；首段 `continued` 为 `undefined`、续段为 `true`，有单测锁住。

### 产品层风险（不是 bug，需记档）

全部 async 之后，**审批类提问失去了"不答就不继续"的硬保证**：工具回执只能写"不要猜"，模型仍可能猜。既然明确不要 `mode`，这条就是已知风险；要兜的话正确位置是在 runtime 给"不可逆工具"加 gate，而不是把 ask 改回 blocking。

## 3. 拆分方案

`room.ts` 被第 2/3/4 组共用，拆分时按 hunk 走（`git add -p`）。

| # | 功能 | 主要文件 | 状态 |
| --- | --- | --- | --- |
| 1 | 插话续段 `continued` | `chat-core/src/timeline.ts`、`surfaces/{astryx,shadcn}/Surface.tsx`、`chat-core/tests/timeline.test.ts` | 已在 5193 验过，最干净 |
| 2 | ask 不阻塞 + 已答卡片留痕 | `entity-runtime/src/{ask.ts,tools/ask.ts,room.ts(settleAsk/human/gate),types.ts}`、`protocol`（`AnsweredAsk` / `Snapshot.answeredAsks`）、`chat-core`（`reduce`/`timeline` ask part/`index`）、`transport-http`、`entity-chat`（`AskCard`/`projection`/两个 surface）、server `GET /asks`、测试 `ask.test` / `tools.test` / `regressions.test` | 修完 P0-2/P1-3/P1-4 可合 |
| 3 | turn.end / end-reason 页脚 | `entity-runtime/src/{agent.ts,providers.ts,session.ts,projection.ts,room.ts(turn.end+publishable),end-reason.ts,stop-scenarios.ts,room-scenarios.ts}`、`protocol`（`TurnEndReason` / `run.finished` / `turn.end`）、`chat-core/{end-footer,timeline,reduce}`、`EntityFooterLine`、`apps/diy2/stops.*`、新样本套件 | 先修 P0-1，并等另一路写完 |
| 4 | 容器管理（改名 / 任务状态 / 删除 / 新建任务） | `apps/diy2/server/index.ts`（`PATCH data` / `DELETE` / seed）、`db.ts`（`deleteRoom`/`deleteBot`）、`room.ts`（`update.data`/`setBotName`/`stop`）、`entity-chat`（`App`/`Sidebar`/`Dialogs`/`RoomName`/`model`/`store`/`ChatPanel`/`BotAvatar`） | 与 1~3 完全无关，独立 PR |
| 5 | `pkgs.ts/core/actor` 新包 + 工程装配 | `pkgs.ts/core/actor/**`、`tsconfig.all.json`、`vitest.config.ts`、`pkgs.ts/vitest.alias.ts` | 纯新增，可单独合；连带 `knip` / 打包看一遍 |

建议顺序：先修 P0-1、P0-2、P1-3、P1-4 → 按 1 / 2 / 4 / 5 / 3 拆分支，每组跑一次测试再合并（第 3 组最后，等并发写作者停手）。

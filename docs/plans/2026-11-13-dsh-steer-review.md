# dsh steer 研究 × 当前 diy2 实现：Review 与接入分工

> 来源：opencode session `ses_e30eed8f4ffehhlqpwZud35dF4`（标题「dsh steer 消息合并逻辑」，2026-11-12 起）。
> 对照对象：`pkgs.ts/agent/entity-runtime`、`apps/diy2/server`、`pkgs.ts/ui/entity-chat`（截至 `a38c0bd`）。

---

## 1. 那个 session 的三条核心结论（先对齐，避免重复研究）

### 1.1 dsh 的 steer 语义

- steer **不打断当前 step、不插进 tool 调用与工具结果之间**；
- 它进 durable inbox（`next-step`），在当前 step 收尾、tool 批次结果落盘之后，**下一个 preStep** 被 claim，作为 **独立的 user 消息**追加在工具结果之后；
- **不合并进工具结果文本**，也不与上一条 user 合并；多条 steer 在同一批次按到达顺序追加；
- steer 会让本要结束的 turn **多跑一步**（`nextStep` 非空 ⇒ 不 break）；
- 真正打断只有 `cancel()`（默认清空 inbox）；`cancel` 后 steer 会被重分类为下一轮；
- 边界：step 失败后残留的 pending steer 没有自动唤醒，需要外部唤醒。

### 1.2 后端抽象（actor 化）

```
AgentRuntime
├── Supervisor（配额/调度）
├── AgentActor(taskUri) × N
│     mailbox：FIFO + 优先级（control > step > turn > fact）
│     state  ：Phase / seq / surfaceGeneration / compaction 版本
│     effect ：LLM 流、工具、落盘（不占临界区，结果以消息回流）
└── SessionLog 单写者 append-only → projections
```

- 六条不变量：seq 在 await 前分配；同 actor 串行；命令必有回执；effect 结果带 runId 且过期即弃；
  同 `(log, context, model)` ⇒ 同一请求（StepPlan hash）；崩溃恢复 = 重放 log。
- `StepPlan` 把「这一轮发给模型什么」变成纯函数值 + hash（变量树、压缩点、工具集、模型都进 hash）。
- **JS 里的 actor 是逻辑隔离**，并行只有 worker_threads；actor 内禁止 await 另一个 actor；token delta 不进 mailbox。

### 1.3 测试纪律（这是「如何测试」的答案）

- 观察面：`Receipt` / `Event 类型序列` / `snapshot` / **fake LLM 的 requests（模型看到了什么）** / 端口调用记录；
- 禁止：断言内部字段、比对整条 JSON、断言 provider wire 格式、读真文件；
- 8 类测试：steer 在 step 边界、工具批次后、cancel、compact、失败残留、并发命令 seq、API 面快照（只暴露三个方法）、日志重放一致。

---

## 2. 当前实现 vs 那份设计（逐项对照）

| 设计项 | 当前实现 | 判定 |
|---|---|---|
| 命令 + 回执（`post → Receipt`） | 没有命令层；server 直接 `runAgent()` | ❌ 缺 |
| 事件 = 事实、可重放 | SSE 即事件，**不落日志**；只持久化 Item | ❌ 缺（重放不可能） |
| 单写者 actor | `chains: Map<entityId, Promise>` 在 HTTP 层 | ⚠️ 效果达到了，位置不对 |
| mailbox 优先级 | Inbox 表有 `mode/status`，但 **drain 时不看 mode**，用户消息立即 drain | ⚠️ 是装饰，不是 mailbox |
| steer（next-step） | **完全未实现**：无 steer 命令、无 step 边界、无“turn 不关”语义 | ❌ 缺 |
| cancel | 有 AbortController，但 UI 停止按钮没接；cancel 不清队列 | ❌ 缺 |
| 多 agent / 投递状态 | 有 routing/outbox（本轮刚做），与 actor 正交 | ✅ 保留 |
| StepPlan / 变量树 | 无；history 直接取最近 20 条文本 | ❌ 缺（P3） |
| UI 节点契约 | Item（type+data）→ ThreadMessageLike，**依赖 assistant-ui 类型** | ⚠️ 方向对，但契约不中立 |
| 双 UI adapter | 只有 assistant-ui 一个 | ❌ 缺（P4） |
| 测试 | **0 个测试文件** | ❌ 最大欠账 |

### 2.1 具体证据

- `entity-runtime/src/inbox.ts`：`mode` 字段写入但 `drain()` 只按 `status='pending'` 取，**等于没有 delivery 边界**；
- `entity-runtime/src/agent.ts`：单次 `streamText`，没有 turn/step 循环，没有 `runId` 过期判定；
- `apps/diy2/server/index.ts`：`chat` 里 `inbox.post` 后**立刻 `drain`**（队列是形式），并发控制靠 `chains`；
- `pkgs.ts/ui/entity-chat/src/store.tsx`：状态在 React，刷新靠 history；没有事件流回放；
- 全仓新包 `find -name '*.test.*'` = 0。

### 2.2 做对的部分

- Item 用 `type` + `data`，UI 只吃投影（和设计的节点契约同方向）；
- 懒创建 assistant 消息（避免空消息/optimistic 占位）——和 dsh「先有事实再有消息」一致；
- 轮次顺序 `turn` + 全局 `order`，并发了也不会乱；
- 多 agent 并行 + outbox 状态，属于设计之外但产品需要的部分，保留。

---

## 3. 结论：我们在 P0 之前，UI 在 P0 之后

用那份 plan 的分期衡量：

| 期 | 内容 | 我们 |
|---|---|---|
| P0 | 纯类型 + fake ports + intent 测试 | **没做** |
| P1 | SessionLog 单写者 + 投影，替换 local-agent | 半步：投影有了，log 没有 |
| P2 | Actor 壳（mailbox/回执/effect 回流） | 半步：串行有了，壳没有 |
| P3 | StepPlan + context facts | 没做 |
| P4 | ConversationModel + 双 adapter | 半步：单 adapter |

**一句话：UI 跑得比内核快，现在靠 HTTP 层和 React state 兜底；再往上加 steer/审批/压缩会开始互相打结。**

---

## 4. 接入方案（接口先冻，再写实现）

```ts
// @diy-agent/agent-kernel（core 侧，无 UI 依赖）
type Command =
  | { kind: 'say'; text: string; delivery: 'step' | 'turn' }
  | { kind: 'cancel'; keepInbox?: boolean }
  | { kind: 'compact'; keep: { kind: 'lastTurns'; n: number } };

interface Receipt { commandId: string; accepted: boolean; seq: number; error?: { code: string; message: string } }

type Event =
  | { seq; type: 'turn.start' | 'turn.end'; turnId; reason? }
  | { seq; type: 'step.start' | 'step.end'; step }
  | { seq; type: 'message.start' | 'message.delta' | 'message.end'; messageId; ... }
  | { seq; type: 'tool.start' | 'tool.end'; callId }
  | { seq; type: 'inbox.enqueued' | 'inbox.claimed'; itemId; delivery };

interface Agent { post(cmd): Receipt; snapshot(): Snapshot; subscribe(afterSeq): AsyncIterable<Event> }
```

- **server**：`/api/entities/:id/*` 变成 kernel 的薄适配（post + 订阅事件 → SSE），`chains` 删掉；
- **UI**：控制按钮直接发命令（停止 = cancel，插话 = say delivery=step），Item 投影保留；
- **steer 只做 next-step**，不做重排/模式切换（按那份 plan 的“不捡”清单）。

---

## 5. 谁来开发（分工建议）

**推荐：内核交给写那份设计的 session，UI/接入留在这里。**

| 工作 | 归属 | 产出 | 验收 |
|---|---|---|---|
| `@diy-agent/agent-kernel`：类型、mailbox、turn/step 循环、命令回执、8 类 intent 测试、API 面快照 | **session `ses_e30eed8f…`**（它已有 dsh 语义与测试模板） | 4 个文件 + tests | `vitest` 全绿；`Object.keys(agent)` 快照 |
| HTTP/SSE 适配、事件→Item 投影、assistant-ui store、steer 队列 UI、停止按钮 | 本 session | server 改造 + UI | 手测：停止、插话在工具执行中不插队，下一步才出现 |
| 契约评审 + shadow 对比（旧实现 vs kernel 事件流） | 两边一起 | review 记录 | 3 个 fixture 的 history/queue 一致 |

**如果要现在开工而不是等**：我可以在本 worktree 直接落 P0（4 文件 + 8 测试），但 dsh 语义细节要照那份 session 的结论写死；
风险是语义漂移，收益是今天就能看到 steer 行为。建议先让内核 owner 答一句“确认按这份契约实现”，再动手。

---

## 6. 建议的下一步（排序）

1. **P0 内核包 + 测试**（别人做，1–2 天）；
2. **server 换成 kernel 适配**（我做，1 天）：删 `chains`、事件落 log；
3. **UI 接 steer/cancel**（我做，1 天）：停止按钮 + 插话队列（在工具跑的时候只入队）；
4. **审批**（P2 之后）：`toolApproval` 作为命令/事件，不再塞在 streamText 回调里；
5. 双 adapter（P4）等内核稳定再说。

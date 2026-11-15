# UI 先行的接入形式与开发计划（本 session 的架构结论汇总）

> 2026-11-13 · 汇总本 session 关于 agent / 单多 agent / inbox / entity / projection 的讨论，
> 对照已实现的 diy2 切片与隔壁 session 的 dsh kernel 设计，给出「UI 继续推进 + 后端逐步接上」的开发形式。

---

## 0. 一句话

**把「UI 与后端之间的契约」当成第一等公民，UI 只依赖契约 + 一个可替换的 Client；
mock 与真后端是同一契约的两个实现。** 这样 UI 不等后端，后端也不被 UI 绑架。

---

## 1. 本 session 已经达成的架构结论（按时间线）

| # | 结论 | 状态 |
|---|---|---|
| 1 | UI 骨架用 assistant-ui（官方模板组件），不自己拼 | ✅ 已落 |
| 2 | 数据链：`Agent 事件 → Item(type+data) → ThreadMessageLike`；UI 不碰 delta | ✅ 已落 |
| 3 | Item 公共字段（id/seq/turn/turnId/status/author/order）+ 私有 data | ✅ 已落 |
| 4 | Inbox = 状态表（可 load/patch/save），不是 append-only；history 才 append-only | ⚠️ 只做了表，语义未用 |
| 5 | 三条流按消费者拆：AgentInbox（进模型）/ NoticeInbox（只给人看）/ Deliveries（谁收到了） | ⚠️ 只有 outbox |
| 6 | Routing（该给谁，冻结收件人）≠ Outbox（发没发出去） | ✅ 已落 |
| 7 | 容器一个 owner；无 @ 只 owner 回；@名字单人；@all 全体；bot 只能单 @ | ✅ 已落 |
| 8 | 实体（项目/任务/bot）即对话；bot 是实体专属；借用 = 分身（每个参与关系一份 session） | ✅ UI 已落，session 未落 |
| 9 | 信封（vars/notify/chat）是模型输入的唯一真源；UI 只吃投影 | ⚠️ 未接 |
| 10 | 顺序：`turn`（发送序）+ `order`（展示序），完成顺序不参与排序 | ✅ 已落 |
| 11 | 失败 = 一条错误事实，不产生空消息；懒创建 assistant 消息 | ✅ 已落 |
| 12 | 测试先行到「意图层」（命令回执/事件序列/模型看到什么） | ❌ 零测试 |

## 2. 隔壁 session（dsh kernel）的结论，与本 session 的交集/分歧

**交集（直接采纳）**

- actor 化：per-entity 单写者 + mailbox + 命令回执 + effect 回流；
- steer 语义：不打断 step，不插进 tool 批次，下一个 preStep 才作为 user 消息追加；turn 保活；cancel 才是打断；
- 事件 = 事实，落 append-only log，可重放；
- `StepPlan` 作为纯函数值 + hash（变量树/压缩点/工具集/模型）；
- 测试纪律：Receipt / 事件类型序列 / fake LLM requests / 端口记录 / API 面快照。

**分歧（需要修正）**

- 它主张 **P0（纯类型+测试）→ P1（log）→ P2（actor）→ P4（UI）** 的顺序；
  但本 session 的现实是 **UI 已经跑到 P0 之前**。按它的顺序会让 UI 停摆 1~2 周。
- 正确处理：**把 P0 里的「契约」提前到第一步**（纯类型，不含实现），UI 立刻改成依赖契约；
  内核仍按 P1→P2 走，但 UI 不再被阻塞。

---

## 3. 现状 review（为什么需要契约这件事）

| 事实 | 问题 |
|---|---|
| UI 的 `Item` 定义在 UI 包里，server 又抄了一份 | 两处定义，已经漂移风险（字段靠手抄） |
| server 的 SSE `kind: item/delivery/error` 是隐式协议 | 没有类型、没有版本、没有快照能力声明 |
| React store 是唯一状态；刷新靠 history 接口 | 事件不可重放；失败/中间态只能靠重载 |
| 并发控制 `chains` 在 HTTP 层 | 换成 ws / ipc / 别的入口就要重写 |
| Inbox 表存在但 drain 不看 mode | “有队列”是假象，steer 无从实现 |
| 零测试 | 每次改动只能靠手测；回归面随功能线性增长 |

**结论：继续加 steer/审批/压缩之前，先把「契约 + 事件日志」这两块补上，否则每加一个功能都会多一处特判。**

---

## 4. 推荐的开发形式：契约 → 双实现 → 逐级接真

```
┌───────────── UI（assistant-ui adapter）─────────────┐
│  只依赖 @diy-agent/chat-contract 与 ChatClient 接口  │
└───────────────▲─────────────────────▲───────────────┘
                │                     │
        MockClient（内存/脚本）   HttpClient（SSE）
                │                     │
                └──────── 同一契约 ────┘
                                      │
                          BFF（apps/diy2/server）
                                      │
                          AgentKernel（actor + log）
```

### 4.1 新增一个纯契约包 `@diy-agent/chat-contract`

只放类型 + 纯函数，**不 import React / node**：

```ts
// 实体与参与者
type Entity = { id; kind: 'project'|'task'|'bot'; name; dir?; projectId?; modelKey; botIds: string[] }
type Bot = { id; name; color; persona; homeEntityId; modelKey }

// 展示条目（已经存在的那套，挪进来）
type Item = … // chat / notice / tool / error / delivery

// 命令（UI → 后端）
type Command =
  | { kind: 'send'; text: string; delivery: 'turn' | 'step' }
  | { kind: 'cancel'; keepInbox?: boolean }
  | { kind: 'compact'; keep: { kind: 'lastTurns'; n: number } }
  | { kind: 'model.set'; target: 'entity'|'bot'; id: string; modelKey: string }

// 事件（后端 → UI，带 seq）
type Event =
  | { seq; type: 'item.upsert'; item: Item }
  | { seq; type: 'delivery'; delivery: Delivery }
  | { seq; type: 'turn.start' | 'turn.end'; turn; reason? }
  | { seq; type: 'notice'; text }

// 客户端
interface ChatClient {
  snapshot(afterSeq?: number): Promise<{ entities; bots; items; deliveries; seq }>
  subscribe(afterSeq: number, onEvent: (e: Event) => void): () => void
  post(entityId: string, command: Command): Promise<Receipt>
}
```

**验收**：契约包有 `contract.test-d.ts`（类型测试）+ 一个 JSON fixture（同一条事件流）。

### 4.2 UI 立刻改成依赖契约（0.5 天）

- `entity-chat/src/model.ts` 删除，改 re-export contract；
- store 里所有 fetch/SSE 换成 `ChatClient`；
- `mockClient`：内存实现 + 脚本化事件（可以演示 steer/审批，不用等后端）。

### 4.3 BFF 只做协议翻译（1 天）

- `HttpClient` ↔ `apps/diy2/server`：`POST /api/entities/:id/command` + `GET /api/events?afterSeq`；
- 现有 SSE 改造为「事件表 + 订阅」，顺手把事件落 log。

### 4.4 内核按需接入（不阻塞 UI）

| 级别 | 后端能力 | UI 可提前做什么（mock） |
|---|---|---|
| L0 | 现状（流式 + 工具 + 多 agent） | — |
| L1 | **事件日志 + afterSeq 重放** | 刷新/断线重连、调试面板（事件原文） |
| L2 | **steer + cancel 命令**（step 边界） | 插话队列 UI、停止按钮、turn 保活提示 |
| L3 | **审批命令/事件** | 审批卡片、暂停态 |
| L4 | StepPlan + context facts | 上下文变化徽标、压缩边界提示 |
| L5 | 第二个 UI adapter（astryx） | 双 adapter 对比页 |

**关键：每一级 UI 都可以先用 mockClient 做完，后端只负责把同一批事件发出来。**
这就是「UI 先行但不假」的形式：不是等后端，也不是对着假 API 写死。

### 4.5 每个 UI 功能的交付定义（Definition of Done）

1. 契约是否有变化？（有则先改 contract + fixture）
2. mockClient 能演示该行为；
3. HttpClient 能收到对应事件（后端可后做，但要先把事件类型定好）；
4. 一条自动化测试：**事件序列 → 期望 Item 树**（投影测试，不需要浏览器）。

---

## 5. 与隔壁 kernel 计划的对齐（避免两边各写一套）

- 隔壁产出的 `Event` 是**最底层**（turn/step/tool/delta）；本 session 的 `Item` 是**投影层**。
  两者之间加一个 `projection` 包（已有雏形），BFF 负责 `kernel Event → contract Event`。
- 契约里的 `Command` 与 kernel 的 `Command` **同名同形**，BFF 不做语义转换（只做路由/鉴权）。
- 内核的 `Receipt` 直接透传；UI 用 `accepted=false` 显示拒绝原因（例如“正在跑，不能压缩”）。
- **不把 token delta 放进契约事件**（否则事件表被淹）：delta 走临时流，只有事实进事件表。

---

## 6. 分工（延续上一份 review 的结论）

| 工作 | 人 | 周期 |
|---|---|---|
| `@diy-agent/chat-contract` + fixture + mockClient | 本 session | 1 天 |
| UI 改依赖契约、steer/停止按钮（mock 可演示） | 本 session | 1–1.5 天 |
| BFF 事件表 + afterSeq 订阅 | 本 session | 1 天 |
| `agent-kernel`（actor/mailbox/steer 语义/8 类测试） | 隔壁 session | 2–3 天 |
| BFF ↔ kernel 接线 + shadow 对比 | 两边 | 1 天 |
| 审批 / StepPlan / 第二 adapter | 之后按 L3–L5 | — |

**判断标准**：UI 的任何新功能，不应等待内核；内核的任何改动，不应要求 UI 改协议。

---

## 7. 风险与止损

| 风险 | 止损 |
|---|---|
| 契约包变成第二个“大而全 Item” | 只放 UI 真正消费的字段；后端字段走 `data` |
| mock 与真后端行为漂移 | 同一 fixture 跑两边的事件，投影结果必须一致（黄金测试） |
| actor 过度设计（Supervisor/配额） | 先只做 per-entity 串行+mailbox；配额等多 agent 真实并发再说 |
| UI 绑死 assistant-ui | 契约中立；adapter 只在一个文件里 import assistant-ui |
| 两套事件（kernel 的 + BFF 的） | BFF 事件类型 = contract；kernel 事件只在 projection 内出现 |

---

## 8. 下一步（按这个顺序做，3 天内能看到 steer）

1. **建 `chat-contract`**（类型 + fixture + mockClient）
2. **UI 切契约**；用 mock 做「插话队列 + 停止按钮」
3. **BFF 落事件表**（append-only）+ afterSeq 订阅；刷新可重放
4. 隔壁 kernel 完成 P1/P2 后，BFF 换成 kernel 事件源（UI 一行不改）
5. 用黄金测试锁住「事件 → Item」投影

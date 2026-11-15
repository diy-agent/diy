# diy2 对齐：当前工作状态 / 现有 agent 能力 / 需要新增与调整的结构

> 2026-11-12 · 不考虑兼容性，允许重组。本文先对齐「现在在哪」，再给「要加什么、改什么」。
> 证据来自代码阅读（路径与行数已标），未跑通的部分会注明。

---

## 1. 当前工作状态（精确）

| 位置 | 内容 | 状态 |
|---|---|---|
| `~/git/diy-research.worktrees/entity-chat` | `pkgs.ts/entity-chat` 研究原型（Vite 单页，:5180） | **纯 UI + mock**，已提交 |
| `~/git/diy.worktrees/diy2-entity-chat` | `pkgs.ts/ui/entity-chat`（包）+ `apps/diy2`（:5190） | **纯 UI + mock**，已提交（`7e5f9b6`） |
| 两侧 `store.tsx` | 假流式（setInterval 逐字追加）+ 内存实体表 | 没有 RPC、没有真模型、没有持久化 |

**已经具备的 UI 形状**：项目/任务/bot 即对话、实体专属 bot、bot 独立对话、模型 chip + 默认模型、可折叠侧栏。

**还没接的**：Agent、Inbox、Envelope、RPC、持久化、审批、工具卡。

---

## 2. 我们要的（已对齐的需求）

1. 实体（项目/任务/bot）= 对话对象；owner bot 名字 = 实体名；
2. 实体专属 bot；可加入现有 bot（借用，归属不变）；加 bot 即多 agent；
3. 消息 = YAML 信封（`vars/notify/chat`，作者在 `chat[].from`）；UI 只吃投影后的 Item；
4. Inbox = 状态表（pending/claimed），每 actor 串行；
5. Routing（该给谁，纯函数冻结收件人）与 Outbox（发没发出去）分开；
6. 工具、审批、取消/steer、压缩、用量；
7. 模型 = provider/account/model 三段式，实体与 bot 可覆盖；
8. 持久化：history append-only；队列可读写。

---

## 3. 现有 agent 调研结论（代码级）

### 3.1 `@diy-agent/bot` 的 `Agent` 聚合（`pkgs.ts/agent/bot/src/aggregate.ts`，约 700 行）

**已满足**

- `send / post / cancel / compact(strategy)` —— 命令，返回 `Receipt`；
- `snapshot / history({sinceSeq, raw})` —— 查询；投递视图 vs 原始日志；
- `subscribe({afterSeq})` —— 带 seq 的事实流；
- 三条硬约束：seq 在 `await` 前同步分配、同一 Agent 串行（`SerialExecutor`）、命令必须有回执；
- `takeFailure()` —— 失败是事件不是状态。

**缺口**

| 缺什么 | 影响 |
|---|---|
| 事件种类少：`message.accepted/run.started/message.delta/message.completed/run.completed/job.updated/tool.started/tool.completed/compact.*` | 没有 `reasoning.*`、`approval.*`、`delivery.*`、`plan.*`，UI 画不出审批/投递/计划 |
| 工具事件只有 start/completed，没有参数流与三态 | 工具卡无法显示"参数正在生成 / 等待审批 / 中断" |
| `send` 只收文本 | 不认信封（`vars/notify/chat`），多成员发言无处安放 |

### 3.2 `BotChatHost`（`pkgs.ts/agent/bot/src/protocol.ts:199`）

**已满足**：多 bot（create/update/remove/select）、**流式 `send(text, onDelta)`**、`compactInfo/compact`、
`WireMessage{ role, blocks }` 且 `Block{kind: string, id, data}` —— 已是"主进程侧归一化，renderer 只画"的思路。

**缺口**：只覆盖 bot，没有 project/task；只有 `text/think/tool` 三个内置 kind；没有 author / room / delivery；
快照是"整页重绘"（`send` 返回全量 messages）。

### 3.3 `LocalAgentManager`（`apps/diy-app/src/main/services/local-agent.ts`，约 6500 行）

**能力最全**：流式、工具、压缩、steer 队列（list/add/cancel/reorder/toggle）、查找、分页、审批（在工具执行链里）、
用量与成本告警、ops 回放。

**问题**：能力绑在 ops 块协议与 Solid UI 上；类体量过大；UI 直接消费 ops 形状。

### 3.4 房间（`apps/diy-app/src/main/services/room-service.ts` + `api-domains/room`）

- **room = taskUri**（每个任务恒是一个 room）—— 与我们的「实体即对话」一致；
- 已有 `deliveryPlanFor`（**就是 Routing**）与 `deliveries.jsonl`（**混了 Outbox**）；
- 支持 @ / focus / steer 注入。

### 3.5 信封（`pkgs.ts/agent/context/src/envelope.ts`）

- `vars`（隐藏增量）/ `notify`（机器事件可见）/ `chat`（发言，`from` = 作者）—— 正是我们要的真源；
- system 侧 `help` + `vars` 全量；
- **缺口**：没有 Inbox 作为 notify 的来源；没有"notice 立即进 UI、批量进模型"的双时钟。

### 3.6 模型（`pkgs.ts/model/provider` + `~/.diy/model.yaml`）

- 三段式 `account@provider/model`、provider 目录、账户、默认模型 —— **已满足**。

---

## 4. 满足度矩阵

| 需求 | 现有 | 差距 |
|---|---|---|
| 实体即对话（项目/任务/bot） | room=taskUri；bot 有独立会话 | 没有统一的 Entity/Conversation 抽象 |
| 实体专属 bot + 借用 | bot 有归属（bot.json） | 没有"参与关系"（borrowed）概念 |
| 流式 + 工具 + 审批 | local-agent 全有；Agent 缺事件 | 事件补全，或让 Agent 驱动 local-agent |
| 消息 = 信封 | 有 envelope（system/user） | inbox → notify 的 flush 没有 |
| Inbox 状态表 | 有 steer 队列、inbox（通知） | 没有 actor 级 inbox + claimed/回收 |
| Routing / Outbox | deliveryPlanFor + deliveries | 需要拆命名与存储形状 |
| 持久化 | ops.jsonl / llm.jsonl / deliveries.jsonl | 队列需可读写；历史保持 append-only |
| 模型 | 三段式目录 | ✅ |

---

## 5. 需要新增的结构（建议）

> 命名按「领域在前」，一个包一个职责。均在 `pkgs.ts/` 下，不需要兼容旧代码。

| 新增 | 职责 | 形态 |
|---|---|---|
| `pkgs.ts/entity/` | `Entity{kind:project\|task\|bot, dir, ownerBotId, participants[], modelKey}`；项目/任务树；borrow 关系 | 纯数据 + 纯函数 |
| `pkgs.ts/agent/inbox/` | 每 actor 的队列状态表：`pending/claimed`、幂等键、seq、超时回收；`post/drain/complete/release` | 状态表（SQLite 或原子 JSON） |
| `pkgs.ts/agent/projection/` | `AgentEvent[] → Item[]`（`type`+`data`）；含 reasoning/tool/notice/delivery | 纯函数 + golden 测试 |
| `pkgs.ts/agent/conversation/` | 参与者容器：Routing（冻结收件人）+ Outbox（状态机）+ 把 inbox 条目组装成 Envelope | 命令 + 订阅 |
| `pkgs.ts/agent/events/` | 事件类型与 seq 契约（可并入 projection 包） | 纯类型 |
| `pkgs.ts/ui/chat-view/` | `Item` 的 React 渲染器（可被 diy2 / web / electron 复用） | React 组件 |
| `apps/diy2` + `pkgs.ts/ui/entity-chat` | 已有；改为消费 RPC | ✅ 已有壳 |

**RPC 面（新域）**：

```
entity.*        list / create(project|task) / rename / addBot / removeBot / setModel
agent.*         send / cancel / steer / approve / history(afterSeq) / subscribe
conversation.*  routing（只读）/ outbox（只读）/ post
```

---

## 6. 需要调整或退役的结构

| 现有 | 处置 | 理由 |
|---|---|---|
| `pkgs.ts/ui/chat-page`（React bot 页，2.1k 行） | **退役**，由 `entity-chat` + `chat-view` 取代 | 只覆盖 bot；快照整页重绘 |
| `renderer_solid/components/local-chat`（5.3k 行） | **冻结**（只修致命 bug） | Solid 孤岛、ops 耦合 |
| `local-agent` 的 ops 块协议 | 不再作为 UI 协议；作为**内部事件源**保留或逐步替换 | 前向兼容差、块类型无界 |
| `bot/protocol.ts` 的 `WireMessage/Block` | 合并进 `Item`（保留 `kind + data` 的思路） | 避免两套投影模型 |
| `BotChatHost` | 变成 `Conversation` 的一个 adapter（或删除） | 语义被 Conversation 覆盖 |
| `room-service` 的 `deliveries` | 拆成 `routing`（纯函数）+ `outbox`（状态） | 两件事混在一张表 |
| `inbox.ts`（通知信箱） | 更名 `notice-inbox`，与 `agent/inbox` 并列 | 避免同名不同义 |
| `Agent` 聚合 | 补事件：`reasoning.* / approval.* / delivery.* / plan.*`；`send` 收信封 | 否则 UI 画不出审批/投递 |

---

## 7. 目标数据流（端到端）

```
UI（entity-chat / chat-view）
   ▲  Item[]（type + data，含 author/status）
   │  RPC: agent.subscribe(afterSeq)
Projection（纯函数）
   ▲  AgentEvent[]（seq）
Agent（每参与者一个）  ←── Inbox（pending/claimed，串行）
   │  send(envelope)
   ▼
Envelope（vars/notify/chat，YAML）→ LLM

Conversation（房间/项目/任务）
   ├─ Routing：消息 → 收件人（冻结）
   ├─ Outbox：每个收件人的投递状态
   └─ 把 inbox 的 notify 批量 flush 进下一次信封
```

---

## 8. 迁移顺序（无兼容，按可验收切）

| 步 | 产物 | 验收 |
|---|---|---|
| 1 | `entity` 包 + RPC `entity.*`；diy2 从 mock 切到 RPC | 左侧树来自后端；改名/建任务落盘 |
| 2 | `inbox` 状态表 + `agent.send` 接信封 | 发一条 → inbox 出现 → drain → 信封可见 |
| 3 | `projection` 包 + `agent.subscribe` | UI 流式、工具卡、reasoning |
| 4 | 审批事件 + 前端卡片 | 工具暂停/批准/继续 |
| 5 | `conversation`（routing/outbox）+ 多 bot | 2-3 个 bot 并行、投递状态可辨 |
| 6 | 持久化（SQLite 或原子 JSON）+ 重连 afterSeq | 刷新不丢、断线补齐 |
| 7 | 退役 chat-page、冻结 Solid 页 | 只有一条 UI 主线 |

---

## 9. 待拍板（会影响结构）

1. **Agent 复用哪一个**：扩展 `bot/aggregate.Agent`，还是把 `local-agent` 的能力并进一个新的 `Agent` 实现？
   （前者干净但缺工具/审批；后者全但 6.5k 行、ops 耦合）
2. **Inbox 存储**：`node:sqlite` 还是原子写 JSON？（决定是否引入 DB 文件）
3. **实体目录**：项目目录是否就是 bot 的 workspace（bot 在项目目录里跑工具）？
4. **borrowed bot**：借用是"参与关系"还是"复制一份独立 bot"？（现在 UI 是前者）
5. **信封与项目/任务的关系**：一个实体一份信封日志，还是每个参与者一份（它自己的会话历史）？
   现在的实现是**每个参与者一份会话**，房间只做投递。

---

## 10. 已拍板（2026-11-12 用户决定）

1. **清理旧 diy2**：删除 `apps/chat`、`apps/minimal`、`apps/web`、`pkgs.ts/ui/chat-page`（旧的 bot 页面链）。
   相关脚本/别名/tsconfig 引用一并清理。
2. **样式**：diy2 就用当前默认（Tailwind + 现有令牌）；**旧的 M3 令牌桥暂不使用**，
   样式问题回头单独讨论（`pkgs.ts/ui/design` 保留，不接）。
3. **Agent**：`aggregate.Agent` 或完全重建都可以（以事件契约与可测试性为准）。
4. **Inbox 存储**：`node:sqlite`。
5. **目录语义**：**workspace ≠ bot 的工作目录**。
   - workspace 是「项目的一种分割」（例如默认 workspace 里放一组相关项目）；
   - bot 是独立实体，可以有自己的目录；
   - 目录结构重新设计（见 §11）。
6. **borrowed bot = 分身**：借用是参与关系，**每个参与关系有自己的 AgentSession**（同一 bot 在两个实体里是两个分身）。
7. **对话顺序建议**：先 bot 端到端，再 task，最后 project（见 §12）。

---

## 11. 目录模型（按拍板重排）

```
Workspace（分割，可多个）
  └── Project（有目录 dir）
        └── Task（继承 project.dir，可覆盖）

Bot（独立实体）
  ├── homeDir（可选，自己的目录）
  └── Participation（参与关系：entity × bot → 一个 AgentSession）
```

落盘建议：

```
$DIY_HOME/
  workspaces/<workspaceId>/…        # 项目/任务的数据（会话、产物）
  bots/<botId>/…                    # bot 自己的目录（可选）
  entities/<entityId>/inbox.db      # AgentInbox（sqlite）
  conversations/<entityId>/…        # routing / outbox / 时间线
```

> 注意：`@diy-agent/bot` 现在的 `workspaceOf(home, botId)` 把 "workspace" 当成 bot 的会话目录 ——
> 与上面的语义冲突，需要改名（bot 的目录不叫 workspace）。

## 12. 开发顺序（建议）

**先 bot 端到端，再 task，最后 project。**

理由：
- bot 是最小参与者（单 actor、无 routing/outbox），但它要走完整链路：Inbox → Agent → Projection → UI → 持久化；
- task/project 主要是**增加参与者与分组**（Conversation、routing/outbox、workspace 树），
  可以在同一套 actor 上做增量，不需要重写；
- UI 已经按 entity 泛化，先做 bot 不会返工。

具体：
1. bot：Inbox（sqlite）+ Agent + Projection + 真 UI（流式/工具/审批）；
2. task：多参与者（routing/outbox）+ 同一套 UI；
3. project：workspace 分割 + 项目目录 + 默认模型继承。

## 13. 信封归属（解释）

两本账，别混：

| 账 | 内容 | 谁读 |
|---|---|---|
| **实体时间线**（entity timeline） | 房间/任务里发生的所有消息与通知（1 份） | UI、routing |
| **参与关系会话**（participation session） | 某个 bot 在这个实体里**看到/说过的**（每个 bot 一份） | 模型（信封）、压缩 |

一条房间消息进来：
1. 写实体时间线 1 条；
2. 对每个收件人，把「该 bot 该看到的部分」包成 user 信封，append 进**它自己的 session**；
3. bot 的回复作为 assistant 消息留在自己的 session，同时作为一条 chat 写回实体时间线。

所以「信封日志」= 每个参与关系一份；「时间线」= 每个实体一份。
借用即分身：bot 在两个实体 = 两个 participation = 两份 session、各自压缩、互不影响。

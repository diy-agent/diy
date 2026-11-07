---
desc: Agent 事件记录协议（设计已收敛未实现）：七元结构 / type+data / Context Tree / 回放
updated: 2026-10-22
---

## context-tree

事件日志 ≠ model wire：**Context Tree 是唯一上下文状态**（不维护事实树与投影树两套），三层 = `places`（割点集合，唯一 placement 配置）/ system 容器（每请求全量重建）/ runtime 容器（路径级 patch + 定期 snapshot）。规则：places 两两不可互为祖先后代；system 不进消息历史故不需补丁；compaction / 恢复 / patch 超阈值 / placement 迁移 / wire 版本升级 / 用户手动 ⇒ 发全量 snapshot 且 `supersedes: all`；变化按 step 最终 hash 比较（中途改后恢复原值 = 未变）；`WIRE_VERSION = sha256(canonical(WIRE_ENCODING)).slice(0,8)`。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:531）

## entity-types

实体/事实类型固定几类：`message.submitted`（用户消息是 `unary+single`，不拆 start/delta/stop；发送失败也**不删**这条事实）；`text`/`think` = `stream` + `content|completed|failed`；工具统一 `entity.type=tool` + `fact.data.name`（**不为 bash/read 各建 `tool.bash` 实体类型**）；`context` = `replaced|patched|snapshot|removed`；`decision` = `made`。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:451）

## id-rule

**实体 id 与事件 id 分离**：实体 id 是 session 局部可读层级路径（`session/1/turn/1/step/1/tool/1`），表示持续存在的实体；eventId 是 `session/1/event/42`，表示一条具体记录。工具服务商的 `callId` 留在 `fact.data`，**不当实体 id**（同一实体可有多条事件；按实体回放、按事件追踪）。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:353）

## legacy-map

旧协议 → 新协议：`start`→`phase=begin`+声明实体；`delta`→`phase=data`+对应 `fact.type`；`patch`→`phase=data`+具体事实类型；`stop`→`phase=end`；user 三段消息→`unary+single` 的 `message.submitted`；`meta`→结构字段；`fields`→`fact.data`；`kind`→`entity.type`；`parent`→`entity.parent`。**未发布阶段直接切换，不做迁移兼容**。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:624）

## no-action-op

**`action` / `op` / `start|stop|delta|patch` 都不再作为事件字段**：`action` 表示命令或意图（`tool.call`），持久化日志记**已发生的事实**（`tool.requested` / `context.replaced`）；`start/stop` 只是流生命周期 ⇒ `frame.mode(unary|stream)` + `frame.phase(single|begin|data|end|abort)`。旧 `delta` 由 `phase=data` 表达（不再需要 `delta_content`）。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:50）

## not-doing

当前不做（边界，防扩散）：不提前设计插件 id 分配协议、不把 dsh 当 runtime 依赖、**不实现 in-history system**（直到真实验证 `gpt-5.6-luna + zen.go + AI SDK` 的能力）、不混用 action/op/start-stop、不为每个工具建 entity kind、不把 TS 泛型当协议必需、不设通用 body、不为插件预留未定字段。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:671）

## overview

**设计已收敛、尚未实现**。目标：事件日志单行自描述、可区分「谁写 / 内容来自谁 / 为什么」、同时表达一次性与流式、实体树 + 并发交错、JSON 与 TS/Zod 同构、插件扩展不污染 core。七元：`source`（哪个模块写）/ `origin`（内容来自谁）/ `entity`（事实依附的实体）/ `frame`（流阶段）/ `fact`（实体实际发生什么）/ `cause`（为什么）/ `eventId + ts`。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:20）

## parent-vs-cause

**`entity.parent` 与 `cause` 不可混用**：parent = 实体树的结构关系（只在实体首次出现时给，后续靠 id 引用）；cause = 事件之间的因果关系。于是系统同时有「实体关系树 / 事件关系有向图 / 日志线性追加序列」三层 —— 这正是多工具并发、事件交错、独立回放的基础。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:336）

## replay

持久化仍 **append-only JSONL**：回放器 `JSONL → EventRecord → 实体树/事件索引 → blocks/messages/context projection`。未闭合流**不能当完整事实**（`begin → data×N` 无 end）；各实体自定中断策略，context 未闭合时不投影且标 rebaseline（老历史无有效 context 时首次打开自动生成 baseline）。UI 默认折叠 context / decision 事件。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:569）

## source-origin-cause

三分必须分清：**`source` = 哪个 diy 模块实际写出这条记录**（`diy.ui` / `diy.agent.transport` / `diy.tool-runner` / `diy.prompt`，由宿主代码确定，**不能由 LLM 或工具参数填写**）；**`origin` = 事实内容来自谁**（`llm{provider,model}` / `user{channel}` / `process{name,pid}` / `application{module}`，同样 `type+data`）；**`cause` = 为什么发生**（`{eventId, relation}`，如 `response-to`）。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:259）

## three-authorities

**三种权威数据必须分开**（可以同文件但用途不同）：`ops` 事件事实日志 = UI / 审计 / 回放 / 状态投影的权威；`llm` 消息历史 = 续聊构造下一次请求的权威；`raw` 请求观测 = 旁路 HTTP/stream 快照（仅调试，可选）。UI **不应**直接把 LLM 消息日志当事件日志，LLM 也**不应**依赖 UI 展示模型。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:686）

## type-data

统一判别结构 = **`{type, data}`**：「判别键同级 = 公共字段，分支私有进 `data`」。**不用** `{type, [type]: …}`（类型名成动态字段、会与公共字段碰撞），也**不设通用 `body` 杂货袋**；`status` 这类公共元数据留在 `fact` 同级。**不要求 TypeScript 泛型**（普通判别联合 + 接口继承即可），但运行时仍需 Zod（TS 类型会被擦除）。

（见 b0ff9948:docs/plans/2026-09-22-agent-event-protocol.md:156）

# @diy/talk — 对话容器内核（事件 / 锚点 / 反应 + role 铁律）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零依赖纯内核**：不 import `node:fs` / `electron` / `@diy/app`，**不取时间**（`at` 由调用方传入）⇒ 现在即可拆成单独项目。需求真源是 `tests/intent.talk.test.ts`（R1–R7）。

## find — 包内定位

- `find.spec` — `SPEC.md` **决策记录**（为什么锚点统一成 `{type,data}`、为什么 doc-range 必钉 revision、为什么 replyTo 是 id 而非文字、为什么 role 不留例外开关）；需求真源是意图测试
- `find.anchor` — `src/anchor.ts`：`Anchor = message | doc-range | task-field | node`；doc-range 的 `{revisionId, offset, quote}`
- `find.event` — `src/event.ts`：`Event { id, author, anchor, content, causes, at }`（##166 §10.2 的容器无关泛化）
- `find.reaction` — `src/reaction.ts`：`Reaction { …, turnId, target, replyTo, … }` + `assertThreadRefs`（悬空 / 自指 / 重号）
- `find.role` — `src/role.ts`：`assemblyRole` + `assertRoleAssignments`（铁律：他人发言绝不能装配成 `assistant`）
- `find.serialize` — `src/serialize.ts`：JSON 出入口（写读两侧都校验，不静默丢弃）
- `find.consumers` — **暂无消费者**；接在后面的是 ##313(`@diy/flow` 泳道容器) / ##314(装配器) / ##319(宿主接入与落地格式)

## rule — 硬约束

- `rule.zero-dep` — 零依赖纯内核；新增 import 前先想「这还能单独拆出去吗」（意图测试 R7 会静态拦 `node:` / `electron` / `@diy/app` 与取时间）
- `rule.no-time` — 包内**不许取时间**：`at` 由调用方传入（可重放、可测试）
- `rule.data-only` — 只做数据与纯函数：**不做存储、不做装配**（不碰 fs、不拼 prompt、不产 `messages[]`）
- `rule.loud` — 非法 anchor / 悬空 `replyTo` / role 违规一律抛 `TalkError`（带 `code` + 点路径），**绝不静默丢弃** —— 静默的后果是「装配出来的历史少一条反驳」
- `rule.discriminated-union` — 类型化节点一律 `{ type, 公共字段, data }`（仓库全局规则）：分支私有数据只进 `data`，判据 key 同级不放私有字段

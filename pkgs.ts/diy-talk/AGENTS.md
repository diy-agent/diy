# @diy/talk — 对话容器内核（事件 / 锚点 / 反应 + role 铁律 + 装配器）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零依赖纯内核**：不 import `node:fs` / `electron` / `@diy/app`，**不取时间**（`at` 由调用方传入）⇒ 现在即可拆成单独项目。需求真源是 `tests/intent.talk.test.ts`（R1–R7）与 `tests/intent.assemble.test.ts`（A1–A6）。

## find — 包内定位

- `find.spec` — `SPEC.md` **决策记录**（为什么锚点统一成 `{type,data}`、为什么 doc-range 必钉 revision、为什么 replyTo 是 id 而非文字、为什么 role 不留例外开关）；需求真源是意图测试
- `find.anchor` — `src/anchor.ts`：`Anchor = message | doc-range | task-field | node`；`pinsRevision` 三态（`true|false|null`，null=不在修订轴）；构造器一律自检
- `find.event` — `src/event.ts`：`Event { id, author, anchor, content, causes, at }`（##166 §10.2 的容器无关泛化）
- `find.reaction` — `src/reaction.ts`：`Reaction { …, turnId, target, replyTo, … }` + `assertThreadRefs`（悬空 / 自指 / 重号 / 异锚点）
- `find.role` — `src/role.ts`：`assemblyRole` + `assertRoleAssignments`（铁律：他人发言绝不能装配成 `assistant`）；非法 `kind` 报错
- `find.serialize` — `src/serialize.ts`：JSON 出入口（写读两侧都校验；`{compact}` 单行供 jsonl，`{allowUnknown}` 读侧前向兼容）
- `find.assemble` — `src/assemble.ts`：`assemble({ sources, strategy, window, selfId }) → Message[]`；源 `reactions|trace|material`，三内置策略 `full|text-only|changes-only`（##166 结论 4）；**他人过程（tool/thinking）永不进入（`full` 也不，由 `role.ts` 最终把关）**；`window` 是宿主注入的**可信**裁剪钩子 —— 其输出不再复核铁律（内核不自作主张）
- `find.consumers` — `@diy/flow`(##313 泳道容器) 已依赖；装配器 `assemble` 供 ##319（宿主接入与提示词装配）消费

## rule — 硬约束

- `rule.zero-dep` — 零依赖纯内核；新增 import 前先想「这还能单独拆出去吗」（意图测试 R7 会静态拦 `node:` / `electron` / `@diy/app` 与取时间）
- `rule.no-time` — 包内**不许取时间**：`at` 由调用方传入（可重放、可测试）
- `rule.data-only` — 只做数据与纯函数：**不做存储**（不碰 fs）；装配是纯函数 `assemble`（不碰具体 LLM SDK、不拼 prompt 的具体形状）
- `rule.loud` — 非法 anchor / 悬空 `replyTo` / 异锚点混串 / role 违规 / **未知字段**一律抛 `TalkError`（带 `code` + 点路径），**绝不静默丢弃** —— 静默的后果是「装配出来的历史少一条反驳」
- `rule.discriminated-union` — 类型化节点一律 `{ type, 公共字段, data }`（仓库全局规则）：分支私有数据只进 `data`，判据 key 同级不放私有字段

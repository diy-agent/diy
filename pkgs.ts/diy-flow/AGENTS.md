# @diy/flow — 工作流内核（定义 DSL + 泳道容器 + 轨迹投影）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**纯内核**：不 import `node:fs` / `electron` / `@diy/app`，
> **不取时间**（事件的 `at` 由调用方传入）⇒ 现在即可拆成单独项目。唯一依赖是 `@diy/talk`
> （复用 `Event` 原语，`anchor = node` 指目标节点）。需求真源是 `tests/intent.flow.test.ts`（R1–R7）。

## find — 包内定位

- `find.define` — `src/define.ts`：`defineWorkflow(def)`；节点字段 `{ id, name, actor, guard[], hint, art?, params? }`，边字段 `{ from, to, when?, kind }`
- `find.container` — `src/container.ts`：单指针容器 —— `createContainer(def).apply(event)`（不可变）；一条转移 = 一条 `@diy/talk` 的 `Event`（`anchor.data.nodeId` = 目标节点）
- `find.project` — `src/project.ts`：`project(events, def) → { currentNode, path: Visit[], visits }`（折线投影，纯函数）
- `find.intent` — `tests/intent.flow.test.ts`：需求真源（三场景轨迹取 ##166 §14.3 的实例）

## rule — 硬约束

- `rule.lane-1to1` — **泳道 ≡ 节点，1:1**（##311 §一 用户决议）：无 `lanes` 段，`name` 只是节点自带的泳道显示名
- `rule.bounce-no-node` — **打回不新建节点**（##166 §14.2 推论 2）：`kind: 'bounce'` 只是让目标节点**再驻留一次**（`Visit.seq` 递增），边只影响画线与标注、**不改结构**
- `rule.id-guard` — **唯一保留的护栏**：`edges[].from/to` 只能取节点 id 的字面量联合（`defineWorkflow` 的 `const` 元组泛型推断）—— 打错字 / 回退到泳道**编译期报错**
- `rule.single-pointer` — 容器恒只有一个 `position`；`apply` 是纯函数（返回新态，不改入参）；**不允许跳步**（无对应边即 `no-edge`）
- `rule.no-guard-eval` — **不做 guard 求值**（归 ##315）、**不做参数校验**（归 ##316）：本包只做「定义 + 位置 + 投影」
- `rule.loud` — 非法定义 / 非法转移一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默丢弃**

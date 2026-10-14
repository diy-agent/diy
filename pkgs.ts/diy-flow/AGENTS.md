# @diy/flow — 工作流内核（定义 DSL + 泳道容器 + 插件槽 + guard 求值 + 转移执行器 + 轨迹投影）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**纯内核**：不 import `node:fs` / `electron` / `@diy/app`，
> **不触外部世界**（插件副作用全在宿主给的函数体里）、**不取时间**（事件的 `at` 由调用方传入）
> ⇒ 现在即可拆成单独项目。唯一依赖是 `@diy/talk`（复用 `Event` 原语，`anchor = node` 指目标节点）。
> 需求真源：`tests/intent.flow.test.ts`（R1–R7）+ `tests/intent.plugin.test.ts`（R1–R9）。

## find — 包内定位

- `find.define` — `src/define.ts`：`defineWorkflow(def)`；节点 `{ id, name, actor, guard[], hint, art?, params? }`、边 `{ from, to, when?, kind }`
- `find.container` — `src/container.ts`：单指针容器 —— `createContainer(def).apply(event)`（不可变）；一条转移 = 一条 `@diy/talk` 的 `Event`（`anchor.data.nodeId` = 目标节点）
- `find.project` — `src/project.ts`：`project(events, def) → { currentNode, path: Visit[], visits }`（折线投影，纯函数）
- `find.plugins` — `src/plugins.ts`：五个固定槽位（`guard`/`source`/`action`/`render`/`notify`）+ `PluginContext` + 返回值校验；**一个具体实现的字节都不写**
- `find.registry` — `src/registry.ts`：`createRegistry().register(slot, name, fn)` / `.resolve(slot, name)`；未注册即抛 `unknown-plugin`
- `find.eval` — `src/eval.ts`：`parseGuardRef`（`prompt:`/`pred:`/`action:`）+ `classifyGuards`（静态分类，无副作用）+ `evaluateGuards`（与 + 短路）+ `selectEdge`（多条同种边用 `when` 消歧）
- `find.execute` — `src/execute.ts`：`createRuntime(def, { registry, params?, maxBounces?, notify? })` → `step` / `declare` / `status`
- `find.intent` — `tests/intent.flow.test.ts`（定义 / 容器 / 投影，素材取 ##166 §14.3 三场景）· `tests/intent.plugin.test.ts`（槽位 / guard 求值 / 执行器，素材取开发与金融两条真实轨迹）

## rule — 硬约束

- `rule.lane-1to1` — **泳道 ≡ 节点，1:1**（##311 §一 用户决议）：无 `lanes` 段，`name` 只是节点自带的泳道显示名
- `rule.bounce-no-node` — **打回不新建节点**（##166 §14.2 推论 2）：`kind: 'bounce'` 只是让目标节点**再驻留一次**（`Visit.seq` 递增），边只影响画线与标注、**不改结构**
- `rule.id-guard` — **唯一保留的结构护栏**：`edges[].from/to` 只能取节点 id 的字面量联合（`defineWorkflow` 的 `const` 元组泛型推断）—— 打错字 / 回退到泳道**编译期报错**
- `rule.single-pointer` — 容器恒只有一个 `position`；`apply` 是纯函数（返回新态，不改入参）；**不允许跳步**（无对应边即 `no-edge`）
- `rule.guard-and` — **guard 数组 = 与**（用户 2026-10-13 修订）：全部满足才可转移，空数组 = 恒真；求值**短路** —— 遇到第一个失败即停（`action:` 有副作用，不能在已知前项失败后仍执行它）
- `rule.observable-split` — 分水岭是**可观测性**而非节点类型（##166 §10.3）：`pred:`/`action:` → 系统求值并自动转移（`author = system`）；含 `prompt:` → **只能 actor 宣布**，转移本身即一条 Event；规则全表见 `src/execute.ts` 头注
- `rule.guard-fail` — guard 未过 → 有 `bounce` 出边就**打回**（金融 `risk` 节点就是这么回退的），没有则**停在原位**（「卡住」在**边上**，##101 结论四）
- `rule.declare` — `declare` 走 `next` 边时可观测那部分须全过（`guard-failed`）；走 `bounce` 边不设闸门（打回不主张推进）；节点 guard 全可观测时不许 actor 宣布（`not-declarable`）
- `rule.no-downgrade` — 未注册插件 / 非法 guard 引用一律抛 `FlowError`（`unknown-plugin` / `invalid-guard`），**绝不降级**成「永远不通过」或「永远通过」
- `rule.no-side-effect` — 只读查询（`status`）走 `classifyGuards` 静态分类，**不调用插件**（否则查一次状态就下了一单）
- `rule.boundary` — 本包只做内核：不做事件存储（归 ##319）、不校验 `params`（归 ##316）、不渲染（归 ##320）、不调度（`notify` 只给回执）
- `rule.loud` — 非法定义 / 非法转移一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默丢弃**

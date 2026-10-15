# @diy/flow — 工作流内核（定义 DSL + 泳道容器 + 插件槽 + 参数层 + guard 求值 + 转移执行器 + 轨迹投影）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**纯内核**：不 import `node:fs` / `electron` / `@diy/app`，
> **不触外部世界**（插件副作用全在宿主给的函数体里）、**不取时间**（事件的 `at` 由调用方传入）
> ⇒ 现在即可拆成单独项目。唯一依赖是 `@diy/talk`（复用 `Event` 原语，`anchor = node` 指目标节点）。
> 需求真源：`tests/intent.flow.test.ts`（R1–R7，26 例）+ `tests/intent.plugin.test.ts`（R1–R9，43 例）
> + `tests/intent.params.test.ts`（R1–R6，34 例）。

## find — 包内定位

- `find.define` — `src/define.ts`：`defineWorkflow(def)`；节点 `{ id, name, actor, guard[], hint, art?, params? }`、边 `{ from, to, when?, kind }`（`params?` 的形状与规则归 `src/params.ts`）
- `find.container` — `src/container.ts`：单指针容器 —— `createContainer(def).apply(event)`（不可变）；一条转移 = 一条 `@diy/talk` 的 `Event`（`anchor.data.nodeId` = 目标节点）
- `find.project` — `src/project.ts`：`project(events, def) → { currentNode, path: Visit[], visits }`（折线投影，纯函数）
- `find.plugins` — `src/plugins.ts`：五个固定槽位（`guard`/`source`/`action`/`render`/`notify`）+ `PluginContext` + 返回值校验；**一个具体实现的字节都不写**
- `find.registry` — `src/registry.ts`：`createRegistry().register(slot, name, fn)` / `.resolve(slot, name)`；未注册即抛 `unknown-plugin`
- `find.eval` — `src/eval.ts`：`parseGuardRef`（`prompt:`/`pred:`/`action:`）+ `classifyGuards`（静态分类，无副作用）+ `evaluateGuards`（与 + 短路）+ `unevaluatedGuards`（打回声明用：不跑插件）+ `selectEdge`（边上的 `when` 消歧，**单出口也判**，**系统选边与 actor 宣布两侧共用**）
- `find.execute` — `src/execute.ts`：`createRuntime(def, { registry, params?, maxBounces?, notify? })` → `step` / `declare` / `status`；`Transition` 带 `receipts` + `notifyErrors`；`params` 是 L2 的**唯一注入点**（工作流声明了参数就校验 + 合并缺省）
- `find.validate` — `src/validate.ts`：`rejectUnknown`（形状封闭，定义/选项/入参共用）+ `isObject` + `callPlugin`（宿主插件抛错 → 包成 `plugin-threw`）
- `find.params` — `src/params.ts`：参数层（L2）—— `paramsOf(def)` 出 `{ schema, defaults }` · `resolveParams(schema, values)` 校验 + 合并 · `parseParamsSchema` 快照反向校验 · `interpolate` / `renderHint` 做 `${节点 id.局部名}` 插值
- `find.intent` — `tests/intent.flow.test.ts`（定义 / 容器 / 投影，素材取 ##166 §14.3 三场景）· `tests/intent.plugin.test.ts`（槽位 / guard 求值 / 执行器，素材取开发与金融两条真实轨迹）· `tests/intent.params.test.ts`（声明 / 实例值 / 默认合并 / hint 插值 / 快照 / 只改值不改形；素材 = ##311 §二 那三个例子 `ci.command` `review.maxBounces` `review.reviewers`）

## rule — 硬约束

- `rule.lane-1to1` — **泳道 ≡ 节点，1:1**（##311 §一 用户决议）：无 `lanes` 段，`name` 只是节点自带的泳道显示名
- `rule.bounce-no-node` — **打回不新建节点**（##166 §14.2 推论 2）：`kind: 'bounce'` 只是让目标节点**再驻留一次**（`Visit.seq` 递增），边只影响画线与标注、**不改结构**
- `rule.id-guard` — **唯一保留的结构护栏**：`edges[].from/to` 只能取节点 id 的字面量联合（`defineWorkflow` 的 `const` 元组泛型推断）—— 打错字 / 回退到泳道**编译期报错**
- `rule.single-pointer` — 容器恒只有一个 `position`；`apply` 是纯函数（返回新态，不改入参）；**不允许跳步**（无对应边即 `no-edge`）
- `rule.guard-and` — **guard 数组 = 与**（用户 2026-10-13 修订）：全部满足才可转移，空数组 = 恒真；求值**短路** —— 遇到第一个失败即停（`action:` 有副作用，不能在已知前项失败后仍执行它）
- `rule.observable-split` — 分水岭是**可观测性**而非节点类型（##166 §10.3）：`pred:`/`action:` → 系统求值并自动转移（`author = system`）；含 `prompt:` → **只能 actor 宣布**，转移本身即一条 Event；规则全表见 `src/execute.ts` 头注
- `rule.guard-fail` — guard 未过 → 有 `bounce` 出边就**打回**（金融 `risk` 节点就是这么回退的），没有则**停在原位**（「卡住」在**边上**，##101 结论四）
- `rule.declare` — `declare` 走 `next` 边时**先判边上的 `when`**（不可用 → `edge-unavailable`，与系统侧 `stuck` 对齐）再判节点 guard 可观测那半（`guard-failed`）；走 `bounce` 边不设闸门且**不跑 guard / `when`**（`guard.evaluated === false`，打回不主张推进）；`node.actor` 为 `system` 或 guard 全可观测时不许 actor 宣布（`not-declarable`）
- `rule.author` — `declare` 的 `author` 必填非空，且**不得等于内核保留字 `system`**（`invalid-declare`）—— 那是「系统自动求值，无人发言」的标记，冒名会让下游分不清「系统推」与「谁宣布推」；「谁能代表哪个 actor」是宿主知识（归 ##319），内核不校验
- `rule.when` — 边上的 `when` 是**边的条件**（§14.4），与 `guard` 同一套前缀规则：**单出口也照判**（不满足 = 这条边此刻不可用），命中 > 1 → `ambiguous-edge`。**系统选边（`selectEdge`）与 actor 宣布（`declare`）两侧共用同一套语义** —— 同一条边换个方向推得同一个答案；不可观测（`prompt:`）那半由宣布者担责
- `rule.seq` — **副作用次序铁律**（`action:` 是写外部世界的槽）：先分类（零副作用）后求值 · 先拒单后求值 · 打回不求值。改 `step`/`declare` 的判定次序前先读 `src/execute.ts` 头注
- `rule.stuck-reason` — `stuck` 的 `reason` 须区分「压根没有 `bounce` 出边」与「有 `bounce` 边、只是它此刻的 `when` 不成立」
- `rule.step-not-idempotent` — `step` / `declare` 是**状态机驱动**，给同一个 `state` 再调一次就再推一次 ⇒ `action:` 插件**必须幂等**；**要轮询「能不能推进」用 `status()`**（零副作用），别反复 `step`
- `rule.options-closed` — `createRuntime` 的 `options`、`step` 的 `seed` 一律**形状封闭**（未知字段 → `invalid-option`）；`declare` 的 `request` 形状错与 `author` 非法同为 **`invalid-declare`**（同一个 API 一套码）
- `rule.compose-order` — **先注册齐、再 `createRuntime`**（组合期扫描要求名字此刻已注册；`prompt:` 不查）。界线 = **内核只校验自己 `resolve` 的槽**（`guard`/`action`/`notify`）；`render`/`source` 的名字**不查** —— 消费者是 ##320 与装配侧，按需注册合理
- `rule.deadlock` — **`actor: 'system'` 与不可观测 guard 不得共存**：系统判不了（`prompt:`）、actor 又不得宣布 ⇒ 谁也推不动 → 组合期 `invalid-def`（不留到运行期静默卡死、别让 `status()` 说「等 actor」）
- `rule.notify-bypass` — `notify` 是**旁路**：插件抛错 / 回执形状错只记进 `transition.notifyErrors`，**不作废**已落定的 `state`/`event`；插件异常统一包成 `plugin-threw`（带 `cause`）
- `rule.no-downgrade` — 未注册插件 / 非法 guard 引用一律抛 `FlowError`（`unknown-plugin` / `invalid-guard`），**绝不降级**成「永远不通过」或「永远通过」
- `rule.no-side-effect` — 只读查询（`status`）走 `classifyGuards` 静态分类，**不调用插件**（否则查一次状态就下了一单）
- `rule.param-scope` — **参数声明在节点上**（`NodeDef.params`，L1 代码）：局部名 + `type` + `default`（**必填**）；全限定名 = `节点 id.局部名`，实例值是同构嵌套 `ctx.params[节点 id][局部名]`；局部名与「声明了参数的节点 id」都不许含 `.`（点号是限定符）
- `rule.param-types` — 类型全集 `string | number | boolean | enum | list` **只收引擎画得出控件的**（不支持嵌套对象：没有表单渲染方案就别开）；`list` 只装标量；约束 `enum?`（仅 enum）/ `min?` `max?` `unit?`（仅 number），写错类型即 `invalid-def`
- `rule.param-value` — 实例值必须**纯 JSON**（标量 / 标量列表、有限数 ⇒ 可落库、可被 UI 改）；非法值 `invalid-param`、未知节点 / 未知参数名 `unknown-param`，**绝不静默忽略**
- `rule.param-default` — `default` 必填（一个值都不填也要能跑）；声明期的 `default` 与运行期的实例值走**同一个** `checkValue`（两处不分叉）；`resolveParams` 结果全量 + 冻结
- `rule.param-no-shape` — **参数只改值、不改形**：不许增删节点 / 边；「本次跳过某步」= 参数让 `guard` / 边的 `when` 短路（##311 §二）
- `rule.param-export` — `{ schema, defaults }` 快照**单向导出**（供 UI 自动生成表单 / 供文档渲染，##311 §三.5）；`defaults` 只是派生视图（唯一真源 = 每项 `default`，不一致即 `invalid-param`）；`parseParamsSchema` 读回时守与定义期**同一组**不变量（`name`/`node` 不含 `.`、同 `path` 唯一）
- `rule.param-bag-when-undeclared` — 工作流**没声明任何参数**时 `params` 不校验、原样透传（##315 的袋口径）：形状封闭的前提是「形状已声明」，引擎不越权判定自己不认识的键
- `rule.param-hint` — `hint` 里 `${局部名}`（本节点）/ `${节点 id.局部名}` 由 `interpolate` 插值；`$$` = 字面量 `$`、空 `list` 插成空串（合法值）；**定义期**校验占位符（`parseWorkflow` 的 `checkHints`，仅工作流声明了 ≥1 参数时；拼错 / 未闭合 → `invalid-def @ workflow.nodes[i].hint`），运行期找不到参数 / 未闭合 → `unknown-param` / `invalid-param`；`renderHint` 出错定位 `nodes.<id>.hint`
- `rule.boundary` — 本包只做内核：不做事件存储（归 ##319）、参数层在 `src/params.ts`（值从哪来归 ##319）、不渲染（归 ##320）、不调度（`notify` 只给回执）
- `rule.loud` — 非法定义 / 非法转移一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默丢弃**

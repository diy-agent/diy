---
desc: diy-flow 包内定位：哪个文件管什么（工作流内核 @diy-agent/flow）
updated: 2026-11-07
---

## container

`src/container.ts`：**领域层** —— `advance(def, state, { to, at, ref?, params? }) → { state, kind }`（正路）+ `FlowState` / `Visit` / `parseRef`；`createContainer(def)` 是同时刻领域态的只读视图（`.position` / `.path` / `.params` / `.done`）；`apply(event)` 是同文件的**审计适配**（见 `rule.audit-adapter`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:17）

## define

`src/define.ts`：`defineWorkflow(def)`；节点 `{ id, name, actor, guard[], hint, art?, params? }`、边 `{ from, to, when?, kind }`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:16）

## eval

`src/eval.ts`：`parseGuardRef`（`prompt:`/`pred:`/`action:`）+ `classifyGuards`（静态分类，无副作用）+ `evaluateGuards`（与 + 短路）+ `unevaluatedGuards`（打回声明用）+ `selectEdge`（边上的 `when` 消歧，**单出口也判**，系统选边与 actor 宣布两侧共用）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:22）

## examples

`examples/dev.ts`（**范例①：工作流开发包长什么样** —— 6 节点开发工作流声明）+ `examples/dev.plugins.ts`（`pred:ci_green` / `action:pr_mergeable` 假数据实现）+ `tests/examples.dev.test.ts`（跑 ##166 §14.3 轨迹：8 步 / 6 泳道 / 1 打回）。范例**只用公开 API**（`@diy-agent/flow`）、不碰 fs、不引新依赖；`tsconfig.json` 的 `include` 含 `examples/**/*`（否则范例一个字符都不被 `tsc` 检查）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:27）

## execute

`src/execute.ts`：`createRuntime(def, { registry, params?, maxBounces?, notify? })` → `step` / `declare` / `status`；`Transition` 带 `move`（结构化语义）+ 可选 `event` + `receipts` + `notifyErrors`；`params` 是 L2 的**唯一注入点**（##316）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:23）

## intent

`tests/intent.*.test.ts`（素材取 ##166 §14.3 三场景 / 开发与金融真实轨迹 / ##311 §二 的三个参数例子）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:26）

## params

`src/params.ts`：参数层（L2）—— `paramsOf(def)` 出 `{ schema, defaults }` · `resolveParams(schema, values)` 校验 + 合并 · `parseParamsSchema` 快照反向校验 · `interpolate` / `renderHint` 做 `${节点 id.局部名}` 插值

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:24）

## plugins

`src/plugins.ts`：五个固定槽位（`guard`/`source`/`action`/`render`/`notify`）+ `PluginContext` + 返回值校验；**一个具体实现的字节都不写**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:20）

## project

`src/project.ts`：`project(events, def) → { currentNode, path, visits }`（**审计侧重放**，不是领域态来源）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:19）

## registry

`src/registry.ts`：`createRegistry().register(slot, name, fn)` / `.resolve(slot, name)`；未注册即抛 `unknown-plugin`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:21）

## serialize

`src/serialize.ts`：`flowStateToJson` / `parseFlowState` / `flowStateFromJson` / `isFlowState`（读回可信，形状与 talk 的 `serialize.ts` 同形）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:18）

## validate

`src/validate.ts`：`rejectUnknown`（形状封闭）+ `isObject` + `isIsoString` + `sameJson`（键序无关比较）+ `callPlugin`（宿主插件抛错 → 包成 `plugin-threw`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:25）

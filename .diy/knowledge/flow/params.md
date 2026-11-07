---
desc: 参数层（L2）：节点上声明、类型/取值/插值/快照导出
updated: 2026-11-07
---

## param-bag-when-undeclared

工作流**没声明任何参数**时 `params` 不校验、原样透传（##315 的袋口径）：形状封闭的前提是「形状已声明」。**冻结深度随之有差异**（##316 review1 H-1，已知并记录）：声明了参数 ⇒ `resolveParams` 逐项受管（袋与 `list` 都冻结）；没声明 ⇒ 只 `Object.freeze` **顶层**，内层仍是宿主那份、可被插件改。**不统一**的理由：引擎不知道透传袋里是什么（可能是类实例 / 回调 / 宿主的活对象）—— 原地深冻结会改到**宿主自己的对象**，深拷贝则破坏「原样透传」；要统一就得先替宿主定「袋里只准放纯 JSON」，那是 ##316 的口径变更

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:65）

## param-export

`{ schema, defaults }` 快照**单向导出**（供 UI 生成表单 / 文档渲染）；`defaults` 只是派生视图（真源 = 每项 `default`）；`parseParamsSchema` 读回时守与定义期**同一组**不变量（`name`/`node` 不含 `.`、同 `path` 唯一）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:64）

## param-hint

`hint` 里 `${局部名}`（本节点）/ `${节点 id.局部名}` 由 `interpolate` 插值；`$$` = 字面量 `$`、空 `list` 插成空串（合法值）；**定义期**校验占位符（`parseWorkflow` 的 `checkHints`，仅工作流声明了 ≥1 参数时；拼错 / 未闭合 → `invalid-def @ workflow.nodes[i].hint`），运行期找不到参数 / 未闭合 → `unknown-param` / `invalid-param`；`renderHint` 出错定位 `nodes.<id>.hint`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:66）

## param-no-shape

**参数只改值、不改形**：不许增删节点 / 边；「本次跳过某步」= 参数让 `guard` / 边上的 `when` 短路（##311 §二）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:63）

## param-scope

**参数声明在节点上**（`NodeDef.params`，L1 代码）：局部名 + `type` + `default`（必填）；全限定名 = `节点 id.局部名`，实例值是同构嵌套 `{ 节点 id: { 局部名: 值 } }`；局部名与「声明了参数的节点 id」都不许含 `.`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:60）

## param-types

类型全集 `string | number | boolean | enum | list` **只收引擎画得出控件的**（不支持嵌套对象）；`list` 只装标量；约束 `enum?`（仅 enum）/ `min?` `max?` `unit?`（仅 number），写错类型即 `invalid-def`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:61）

## param-value

实例值必须**纯 JSON**（标量 / 标量列表、有限数）；非法值 `invalid-param`、未知节点 / 未知参数名 `unknown-param`，**绝不静默忽略**；`resolveParams` 结果全量 + 冻结

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:62）

## params-in-state

**`params` 值属领域状态**（##311 §二 L3 / ##333 交付 G）：`createRuntime` 把本次用的那份写进产出的 `FlowState.params`（`commit` 随 `AdvanceRequest.params` 交下去；两条 `done` 返回原地加标记、由 `stampParams` 补）。**`advance` 自己也能收 `params`**（纯透传、不改不冻结、不校验值语义）：给了就用本次的、没给就继承入参那份 —— 正路闭环，见 `rule.domain-first`。三条不变量：① 状态带着**另一份**参数值（键序无关比较）⇒ 拒（`invalid-param @ state.params`）；② 状态**已进入却没记参数值**（`position !== null` 且 `params === undefined`，本次运行有参数值）⇒ 拒 —— **「缺省」≠「丢了」**，唯一放行的是尚未进入（`initialState()` 本就不带 `params`，那是另起一次运行的正路；消息里给修法）；③ **`advance` 请求带的参数值与状态里那份不一致** ⇒ 拒（`invalid-param @ request.params`）—— 折线上早先的驻留是拿旧配置跑的，换掉即混配状态、且落盘把旧值抹掉（事后无从发现）；**runtime 与正路同一条口径**（runtime 拒、正路也拒）。值的**语义**校验归 ##316，本包不重写

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:38）

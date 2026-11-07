---
desc: 转移执行器：guard 求值/选边/宣布/终态/次序铁律/报错不降级
updated: 2026-11-07
---

## author

`declare` 的 `author` 必填非空且**不得等于内核保留字 `system`**（`invalid-declare`）；「谁能代表哪个 actor」是宿主知识（归 ##319），内核不校验

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:49）

## deadlock

**`actor: 'system'` 与不可观测 guard 不得共存** → 组合期 `invalid-def`（不留到运行期静默卡死）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:56）

## declare

`declare` 走 `next` 边时**先判边上的 `when`**（不可用 → `edge-unavailable`）再判节点 guard 可观测那半（`guard-failed`）；走 `bounce` 边不设闸门且**不跑 guard / `when`**（`guard.evaluated === false`）；`node.actor` 为 `system` 或 guard 全可观测时不许 actor 宣布（`not-declarable`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:48）

## guard-and

**guard 数组 = 与**（用户 2026-10-13 修订）：全部满足才可转移，空数组 = 恒真；求值**短路**（`action:` 有副作用，不能在已知前项失败后仍执行它）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:45）

## guard-fail

guard 未过 → 有 `bounce` 出边就**打回**，没有则**停在原位**（「卡住」在**边上**，##101 结论四）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:47）

## loud

非法定义 / 非法转移 / 非法快照一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默丢弃**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:68）

## no-downgrade

未注册插件 / 非法 guard 引用 / 非法状态快照一律抛 `FlowError`，**绝不降级**成「永远不通过」或静默丢弃

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:58）

## no-side-effect

只读查询（`status`）走 `classifyGuards` 静态分类，**不调用插件**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:59）

## observable-split

分水岭是**可观测性**而非节点类型（##166 §10.3）：`pred:`/`action:` → 系统求值并自动转移；含 `prompt:` → **只能 actor 宣布**；规则全表见 `src/execute.ts` 头注

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:46）

## options-closed

`createRuntime` 的 `options`、`step` / `declare` 的入参一律**形状封闭**（未知字段 → `invalid-option`；`declare` 一套码 `invalid-declare`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:54）

## seq

**副作用次序铁律**（`action:` 是写外部世界的槽）：先分类（零副作用）后求值 · 先拒单后求值（含审计字段 / 事件形状）· 打回不求值。改 `step`/`declare` 的判定次序前先读 `src/execute.ts` 头注

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:51）

## step-not-idempotent

`step` / `declare` 是**状态机驱动**，给同一个 `state` 再调一次就再推一次 ⇒ `action:` 插件**必须幂等**；**要轮询「能不能推进」用 `status()`**（零副作用）。唯一例外：`state.done` 后重复 `step` 是空转（见 `rule.done-marker`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:53）

## stuck-reason

`stuck` 的 `reason` 须区分「压根没有 `bounce` 出边」与「有 `bounce` 边、只是它此刻的 `when` 不成立」

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:52）

## when

边上的 `when` 是**边的条件**（§14.4），与 `guard` 同一套前缀规则：**单出口也照判**，命中 > 1 → `ambiguous-edge`；**系统选边与 actor 宣布两侧共用同一套语义**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:50）

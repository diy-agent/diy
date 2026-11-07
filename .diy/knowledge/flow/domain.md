---
desc: 领域态一等（##333）：FlowState 真源、advance 正路、落盘读回、审计适配
updated: 2026-11-07
---

## audit-adapter

`apply(def, state, event)` 是**审计 / 消息入口**（薄适配：解 `anchor.data.nodeId` 再调 `advance`），**不参与状态构造**；留它只为「从旧日志重建」（`project`）与老调用方兼容。事件的 `id` / `author` / `content` **一律不进领域态**；**重建不出 `done` / `Visit.ref` / `FlowState.params`**（日志里没有 / `apply` 只解 `nodeId` 与 `at`，且 `project` 从 `initialState()` 起步）—— 要它们只能读落盘的状态文件

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:32）

## domain-first

**领域状态一等**（##333）：位置变更的正路是 `advance`（只吃 `{ to, at, ref?, params? }`，**不吃事件**）；`FlowState` 自成真源、可独立落盘读回。**正路必须产出完整真源**（`params` 也在请求里，否则用正路落盘的状态残缺，读回被 `invalid-param` 拒 —— ##333 review2 P1），且**不许静默换配置**（状态里已有参数值、请求又带不同的一份 ⇒ 拒，换配置 = 另起一次运行 —— review3 P2-1）。凡「让 core 依赖日志 / 为日志好看」的改动一律错

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:31）

## done-marker

终态（guard 全过且**没有 `next` 出边**）把 `FlowState.done = true` 记进**领域态**；重复 `step` 直接返回 `done`，**不求值、不重跑 `action:`**（##315 review2 §D）。判据是**结构事实**：**边上的 `when` 不参与**（`when` 管「这条边此刻能不能走」，不管「有没有下一步」）⇒ 有 `next` 边而 `when` 全不成立 = `stuck`（停在**边上**）；只有 `bounce` 出边的节点 guard 全过 = `done`

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:37）

## event-optional

`EventSeed.id` 可选：**不给 = 不落审计事件**（`transition.event === undefined`），领域照样推进；`notify` 因此只在**落了事件**时才唤醒（无事件 = 无通知，`receipts` 为空）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:36）

## no-human-text

内核**不编人类文本**：转移给 `Move{kind:'entry'|'next'|'bounce', from, to}` + `reason`，审计事件正文由宿主给（`seed.content`，缺省空串）。改 `execute.ts` 时别把文案加回去

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:35）

## ref-passthrough

`ref?: Record<string,string>`（`taskUri` / `turnId` / `stepId`…）**开放袋**：键不封闭（宿主自己命名）、值必须是字符串；内核**只透传不解释**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:34）

## single-pointer

容器恒只有一个 `position`；`advance` / `apply` 是纯函数（返回新态，不改入参）；**不允许跳步**（无对应边即 `no-edge`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:44）

## state-file-not-here

**落盘位置 / 文件布局 / 事件存储 / 谁给参数值**全归 ##319；`done` / `params` / `Visit.ref` 三样**重建不出来**（日志里没有）⇒ 领域态必须自己落盘；##319 按正路落盘时**记得 `advance` 要带 `params`**（或由 runtime 产出）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:40）

## state-serialize

落盘 / 读回只走 `serialize.ts`：写侧先校验规范化（键序固定、字段封闭）、读侧同样严格（`invalid-state` / `invalid-json`）。除形状外还兜**语义自洽**（`position` 与折线末端一致、每节点 `seq` 恰为 `1,2,3…`、`done === true` ⇒ 已进入过）与 `params` 的纯 JSON 性。两条**立场**：**`at` 不要求单调**（次序由 `path` 数组承载、`at` 只是信息 —— 要次序看下标，别信 `at`）；**`params` 只兜纯 JSON 性、不兜值语义**（读回路径不经过 `resolveParams` ⇒ 盘上可能脏，但脏值进不了运行态，唯一闸门是 `createRuntime`）。`allowUnknown` 是**只读检查闸**（放行不保留，别拿它读进来的对象写回）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:39）

## visit-fields

`Visit{node,seq,kind,at}` 四项全是领域事实 + 宿主 `ref?`；**没有日志 id**（旧 `eventId` 已删）。方向反转：审计侧要指回领域，用折线末端的 `{ node, seq }` 作坐标

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:33）

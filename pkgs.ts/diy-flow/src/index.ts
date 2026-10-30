// @diy-agent/flow — diy 工作流内核：定义 DSL + 泳道容器 + 插件槽 + guard 求值 + 转移执行器 + 轨迹投影
//
// 纯内核（唯一依赖 `@diy-agent/talk` 的事件原语）：不 import `node:fs` / `electron` / `@diy-agent/app`，
// **不触外部世界**（插件副作用全在宿主给的函数体里）、**不取时间**（`at` 由调用方传入）。
// 因此现在就能拆成单独项目（##311 §四）。
//
// ##333 依赖反转后的口径（**领域状态一等、事件降为审计**）：
//   · 领域态 `FlowState{ position, path, params }` 自成真源 —— 由 `advance` 产出、可落盘可读回（`serialize.ts`）；
//   · `Event` 只是**进度通知消息 / 审计材料**：`seed.id` 给了才落，不给就是纯领域推进；
//   · 内核**不编人类文本**：`Transition.move` 给结构化语义（`{ kind, from, to }`），渲染归宿主。
//
//   import { createRegistry, createRuntime, defineWorkflow, flowStateToJson, parseFlowState } from '@diy-agent/flow';
//
//   const wf = defineWorkflow({
//       id: 'dev', name: '开发工作流',
//       nodes: [
//           { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '…' },
//           { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '…' },
//           { id: 'ci', name: 'CI', actor: 'system', guard: ['pred:check_green', 'pred:intent_green'], hint: '…' },
//       ],
//       edges: [
//           { from: 'implement', to: 'review', kind: 'next' },
//           { from: 'review', to: 'implement', kind: 'bounce' },   // 打回：不新建节点
//           { from: 'review', to: 'ci', kind: 'next' },
//       ],
//   });   // 入口自动推断 = 'implement'（没有入边的节点）
//
//   // 插件：引擎查不到的东西（读外部世界 / 写外部世界）由宿主按名注册（##166 §13.1/§13.2）
//   const registry = createRegistry()
//       .register('guard', 'check_green', (ctx) => ({ pass: true, reason: 'CI 绿' }))
//       .register('guard', 'intent_green', () => ({ pass: true }));
//   const rt = createRuntime(wf, { registry, maxBounces: 3 });
//
//   // 领域推进：内核不取时间、不生成 id → `at` 由调用方给；`id` 不给 = 不落审计事件
//   const t1 = rt.step(initialState(), { at: '2026-10-13T00:00:00.000Z', id: 'e1' });  // → move.kind = 'entry'
//   if (t1.status === 'moved') {
//       // `prompt:` 不可观测 → 只能由 actor 宣布，**转移本身就是一条发言**（##166 §10.3）
//       const t2 = rt.declare(t1.transition.state, {
//           id: 'e2', at: '2026-10-13T00:00:01.000Z', author: 'Review agent',
//           to: 'implement', content: 'P0 未落点 → 打回',
//       });
//       t2.move;                                             // → { kind: 'bounce', from: 'review', to: 'implement' }
//       flowStateToJson(t2.state);                           // → 领域态落盘（不含任何日志 id）
//       parseFlowState(flowStateToJson(t2.state));           // → 读回可信
//   }
//   // `pred:` / `action:` 可观测 → rt.step 自己求值并自动转移；要不要落事件由 `seed.id` 决定
//
// 三条次序铁律（`action:` 是写外部世界的槽）：**先分类后求值**（含 `prompt:` 的节点，step 一个插件都不调）、
// **先拒单后求值**（非法 declare 不得先动手）、**打回不求值**。`declare` 的 `author` 不得取内核保留字
// `system`；`step` / `declare` 每次调用都会重新求值 ⇒ `action:` 插件须幂等、`done` 后勿轮询
// （跑完的终态记在 `FlowState.done` 里，重复 `step` 不再求值）。
//
// 边界：本包只做**内核** —— 不做事件存储 / 状态文件布局（归 ##319）、不做渲染（`render` 只给形状，
// 画页面归 ##320）、不做调度（`notify` 只给回执）。参数层（L2）已落 `params.ts`：声明在节点上、
// 校验与默认合并由 `createRuntime` 在**工作流声明了参数**时执行（没声明 = 参数层未启用，`params` 仍是透传袋）。
// 事件形状与 `@diy-agent/talk` 的 `Event` 完全一致（##312）：**不另造一套历史**（##166 §八）。

export { FlowError } from './errors.js';
export type { FlowErrorCode } from './errors.js';

export {
    ACTORS,
    EDGE_KINDS,
    RENDERERS,
    defineWorkflow,
    findNode,
    isWorkflow,
    parseWorkflow,
} from './define.js';
export type { Actor, Art, DefineInput, EdgeDef, EdgeKind, NodeDef, Renderer, WorkflowDef } from './define.js';

export { PARAM_TYPES, interpolate, paramsOf, parseParamsSchema, renderHint, resolveParams } from './params.js';
export type { InterpolateOptions, ParamDef, ParamEntry, ParamsSchema, ParamScalar, ParamType, ParamValue, ParamValues } from './params.js';

export { advance, apply, createContainer, initialState, parseRef } from './container.js';
export type { Advance, AdvanceRequest, Container, FlowState, Visit } from './container.js';

export { flowStateFromJson, flowStateToJson, isFlowState, parseFlowState } from './serialize.js';
export type { ParseOptions, SerializeOptions } from './serialize.js';

export { project } from './project.js';
export type { Projection } from './project.js';

export { SLOTS, parseActionResult, parseGuardResult, parseReceipt, parseView } from './plugins.js';
export type { ActionResult, ActionPlugin, GuardPlugin, GuardResult, NotifyPlugin, Plugin, PluginContext, PluginOf, Receipt, RenderPlugin, Slot, SlotPlugins, SourcePlugin, View } from './plugins.js';

export { createRegistry } from './registry.js';
export type { PluginRegistry } from './registry.js';

export { GUARD_PREFIXES, classifyGuards, evaluateGuards, isObservable, parseGuardRef, selectEdge, unevaluatedGuards } from './eval.js';
export type { GuardCheck, GuardEvaluation, GuardMode, GuardPrefix, GuardRef } from './eval.js';

export { createRuntime } from './execute.js';
export type { DeclareRequest, EventSeed, Move, NodeStatus, NotifyFailure, Runtime, RuntimeOptions, StepResult, Transition } from './execute.js';

export { callPlugin, isIsoString, isObject, rejectUnknown } from './validate.js';

// 通用渲染器契约（九种 renderer 各自吃哪种 `data` 形状，##166 §14.7 / ##318）——
// **纯类型导出、零运行时代价**：类型导出不产出任何运行时成员，也不改 `exports` 的子路径策略。
// 消费者（行业工作流包、宿主 UI ##320）按形状**收窄** `View.payload` 的正路就是
//   import type { ViewData, ViewShapes } from '@diy-agent/flow';
// —— 跨包**子路径** import（`@diy-agent/flow/src/view`）才是 hack（`exports` 只有 `"."`）。
export type * from './view.js';

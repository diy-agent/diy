// @diy/flow — diy 工作流内核：定义 DSL + 泳道容器 + 插件槽 + guard 求值 + 转移执行器 + 轨迹投影
//
// 纯内核（唯一依赖 `@diy/talk` 的事件原语）：不 import `node:fs` / `electron` / `@diy/app`，
// **不触外部世界**（插件副作用全在宿主给的函数体里）、**不取时间**（事件的 `at` 由调用方传入）。
// 因此现在就能拆成单独项目（##311 §四）。
//
//   import { createEvent, nodeAnchor } from '@diy/talk';
//   import { createRegistry, createRuntime, defineWorkflow, project } from '@diy/flow';
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
//   // 一条转移 = 一条 Event（anchor = node 指目标节点）；内核不取时间、不生成 id → 由调用方给种子
//   const seed = (id: string) => ({ id, at: '2026-10-13T00:00:00.000Z' });
//   const t1 = rt.step(initialState(), seed('e1'));      // { status: 'moved' … } → 位置 = implement
//   if (t1.status === 'moved') {
//       // `prompt:` 不可观测 → 只能由 actor 宣布，**转移本身就是一条发言**（##166 §10.3）
//       const t2 = rt.declare(t1.transition.state, {
//           ...seed('e2'), author: 'Review agent', to: 'implement', content: 'P0 未落点 → 打回',
//       });
//       project([t1.transition.event, t2.event], wf).path;   // → [implement#1:next, implement#2:bounce]
//   }
//   // `pred:` / `action:` 可观测 → rt.step 自己求值并自动转移，事件 author = 'system'
//
// 三条次序铁律（`action:` 是写外部世界的槽）：**先分类后求值**（含 `prompt:` 的节点，step 一个插件都不调）、
// **先拒单后求值**（非法 declare 不得先动手）、**打回不求值**。`declare` 的 `author` 不得取内核保留字
// `system`；`step` / `declare` 每次调用都会重新求值 ⇒ `action:` 插件须幂等、`done` 后勿轮询。
//
// 边界：本包只做**内核** —— 不做事件存储（归 ##319）、不做渲染（`render` 只给形状，画页面归 ##320）、
// 不做调度（`notify` 只给回执）。参数层（L2）已落 `params.ts`：声明在节点上、校验与默认合并
// 由 `createRuntime` 在**工作流声明了参数**时执行（没声明 = 参数层未启用，`params` 仍是透传袋）。
// 事件形状与 `@diy/talk` 的 `Event` 完全一致（##312）：**不另造一套历史**（##166 §八）。

export { FlowError } from './errors';
export type { FlowErrorCode } from './errors';

export {
    ACTORS,
    EDGE_KINDS,
    RENDERERS,
    defineWorkflow,
    findNode,
    isWorkflow,
    parseWorkflow,
} from './define';
export type { Actor, Art, DefineInput, EdgeDef, EdgeKind, NodeDef, Renderer, WorkflowDef } from './define';

export { PARAM_TYPES, interpolate, paramsOf, parseParamsSchema, renderHint, resolveParams } from './params';
export type { InterpolateOptions, ParamDef, ParamEntry, ParamsSchema, ParamScalar, ParamType, ParamValue, ParamValues } from './params';

export { apply, createContainer, initialState } from './container';
export type { Container, FlowState, Visit } from './container';

export { project } from './project';
export type { Projection } from './project';

export { SLOTS, parseActionResult, parseGuardResult, parseReceipt, parseView } from './plugins';
export type { ActionResult, ActionPlugin, GuardPlugin, GuardResult, NotifyPlugin, Plugin, PluginContext, PluginOf, Receipt, RenderPlugin, Slot, SlotPlugins, SourcePlugin, View } from './plugins';

export { createRegistry } from './registry';
export type { PluginRegistry } from './registry';

export { GUARD_PREFIXES, classifyGuards, evaluateGuards, isObservable, parseGuardRef, selectEdge, unevaluatedGuards } from './eval';
export type { GuardCheck, GuardEvaluation, GuardMode, GuardPrefix, GuardRef } from './eval';

export { createRuntime } from './execute';
export type { DeclareRequest, EventSeed, NodeStatus, NotifyFailure, Runtime, RuntimeOptions, StepResult, Transition } from './execute';

export { callPlugin, isObject, rejectUnknown } from './validate';

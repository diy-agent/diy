// @diy/flow — diy 工作流内核：工作流定义 DSL + 泳道容器 + 轨迹折线投影
//
// 纯内核（依赖 @diy/talk 的事件原语）：不 import `node:fs` / `electron` / `@diy/app`，**不取时间**
// （事件的 `at` 由调用方传入）。因此现在就能拆成单独项目（##311 §四）。
//
//   import { createEvent, nodeAnchor } from '@diy/talk';
//   import { defineWorkflow, project } from '@diy/flow';
//
//   const wf = defineWorkflow({
//       id: 'dev', name: '开发工作流',
//       nodes: [
//           { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '…' },
//           { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '…' },
//       ],
//       edges: [{ from: 'review', to: 'implement', kind: 'bounce' }],   // 打回：不新建节点
//   });   // 入口自动推断 = 'review'（唯一没有入边的节点）
//
//   // 一条转移 = 一条 Event（anchor = node 指目标节点）；首个事件必须进入入口
//   const enter = createEvent({ id: 'e1', author: 'review-agent', anchor: nodeAnchor('review'),
//                               content: '进入 Review', at: '2026-10-13T00:00:00.000Z' });
//   const back = createEvent({ id: 'e2', author: 'review-agent', anchor: nodeAnchor('implement'),
//                              content: 'P0 未落点，打回', at: '2026-10-13T00:00:00.000Z' });
//   project([enter, back], wf).path;   // → [{ node:'review', seq:1, kind:'next', … },
//                                      //    { node:'implement', seq:1, kind:'bounce', … }]
//
// 边界：本任务只做「定义 + 位置 + 投影」——
// **不做 guard 求值**（归 ##315）、**不做参数校验**（归 ##316）、不做事件存储（归 ##319）。

export { FlowError } from './errors';
export type { FlowErrorCode } from './errors';

export {
    ACTORS,
    EDGE_KINDS,
    PARAM_TYPES,
    RENDERERS,
    defineWorkflow,
    findNode,
    isWorkflow,
    parseWorkflow,
} from './define';
export type { Actor, Art, DefineInput, EdgeDef, EdgeKind, NodeDef, ParamDef, ParamType, Renderer, WorkflowDef } from './define';

export { apply, createContainer, initialState } from './container';
export type { Container, FlowState, Visit } from './container';

export { project } from './project';
export type { Projection } from './project';

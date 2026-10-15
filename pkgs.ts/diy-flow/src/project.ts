// project.ts — 轨迹投影：把事件流折成一条折线（纯函数）
//
// ⚠️ ##333 之后的定位：这是**审计侧的重建路径**，不是领域态的来源。
// 领域态的真源是 `FlowState` 本身（由 `advance` 产出、可落盘读回）；`project` 只是「手里只有日志时
// 怎么把折线重放出来」—— 依据 ##166 §12.3「事件本身就是事实，位置只是这些不可变事件的投影」、
// ##311 §六 待决 12.5 的倾向（事件即事实 + 位置为投影，合一）：不持有任何状态，把 `events` 从初始态
// 依次 `apply`，得到最终位置与完整折线。**同一个 `def` + 同一串事件，投影恒等**（可重放、可测试）。
//
// ⚠️ **重建不出**三样东西（这正是「日志可清可丢、领域态必须自己落盘」的具体样子）：
//   ① `FlowState.done` —— 终态标记是运行期由 `step` 求值发现的领域事实，日志里没有；
//   ② `Visit.ref` —— 宿主关联（`taskUri` / `turnId` / `stepId`…）**不在事件里**（`apply` 只解
//      `anchor.data.nodeId` 与 `at`），故重放出来的折线不带 `ref`；
//   ③ `FlowState.params` —— L2 实例参数值**也不在事件里**（`apply` 的请求没有它），本函数又从
//      `initialState()` 起步 ⇒ 重放出来的态没有 `params`。
// 三者都只能由**落盘的状态文件**给出（重建路径拿回的是位置与折线）。

import type { Event } from '@diy/talk';
import { apply, initialState, type Visit } from './container';
import type { WorkflowDef } from './define';
import { FlowError } from './errors';

/** 投影结果：当前节点 + 折线 + 各节点驻留次数 */
export interface Projection<Id extends string = string> {
    readonly currentNode: Id | null;
    /** 折线：按驻留次序排列的 Visit 序列（同一节点可多次出现） */
    readonly path: readonly Visit<Id>[];
    /** 各节点驻留次数（node id → 次数）；无驻留的节点不出现 */
    readonly visits: Readonly<Record<string, number>>;
}

/**
 * 把事件流投影成折线。
 *
 * `events` 须按发生次序传入；id 必须唯一（否则 `duplicate-event-id`）。
 * 任一条事件非法（未知节点 / 无对应边 / 未进入口）即抛 `FlowError` —— 不静默跳过。
 */
export function project<Id extends string>(events: readonly Event[], def: WorkflowDef<Id>): Projection<Id> {
    const seen = new Set<string>();
    let state = initialState<Id>();
    events.forEach((event, i) => {
        if (seen.has(event.id)) {
            throw new FlowError('duplicate-event-id', `事件 id 重复 ${JSON.stringify(event.id)}`, `events[${i}].id`);
        }
        seen.add(event.id);
        state = apply(def, state, event);
    });

    const visits: Record<string, number> = {};
    for (const v of state.path) visits[v.node] = (visits[v.node] ?? 0) + 1;

    return { currentNode: state.position, path: state.path, visits };
}

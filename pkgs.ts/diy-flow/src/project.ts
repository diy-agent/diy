// project.ts — 轨迹投影：把事件流折成一条折线（纯函数）
//
// 依据 ##166 §12.3「事件本身就是事实，位置只是这些不可变事件的投影」、##311 §六 待决 12.5 的倾向
// （事件即事实 + 位置为投影，合一）：`project` 不持有任何状态，把 `events` 从初始态依次 `apply`，
// 得到最终位置与完整折线。**同一个 `def` + 同一串事件，投影恒等**（可重放、可测试）。

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

// src/main/workflows/executors.ts — 「节点 → 执行者」绑定（##341 交付物 1）
//
// 内核的 `NodeDef.actor` 只回答**哪一类**主体推得动这个节点（`agent` / `system` / `human`），
// 回答不了「哪一个 agent」。而 `NodeDef` 形状封闭（`diy-flow/src/define.ts::parseNode` 的
// `noUnknown`）⇒ 加字段就是改内核 —— 本任务硬约束「能不碰就不碰」。所以绑定落在**宿主侧旁表**：
// 按**节点 id** 关联，内核与实例数据零改动。
//
// 本文件只放「形状 + 取法」；表本身跟着定义走（`dev.ts::DEV_EXECUTORS`）——「一个工作流定义 +
// 它的执行者表」是一份东西的两半，分开放反而要人来回跳。
//
// 取法（`executorOf`）**对缺项兜底**：按 `node.actor` 推导（`human` → 等人；`system` → 系统求值；
// `agent` → 无名 agent）。于是驱动环（`services/flow-runner.ts`）对**任意**定义都通用，
// 不写死这一个工作流；将来「工作流开发包」自带执行者表时，这里只是换供给方。

import type { Actor } from '@diy-agent/flow';
import { DEV_WORKFLOW, DEV_EXECUTORS } from './dev';

/** 一个节点的执行者（宿主侧知识：内核只给 `actor`，这一层说清「到底谁去干」） */
export type NodeExecutor =
    | {
          readonly kind: 'agent';
          /** 执行者标识（进审计 `author` 与 turn 消息署名） */
          readonly agent: string;
          /** 角色定位文本（进 turn 消息首部 —— 「哪个 agent」的实质差别在这里） */
          readonly role: string;
          /** 可选人物（id / 显示名）：取它的模型作**本轮**覆盖；缺省用任务绑定的人物 */
          readonly persona?: string;
      }
    | { readonly kind: 'human' }
    | { readonly kind: 'system' };

/** 各工作流的执行者表（键 = 定义自己的 `id`）。**只增不改**：实例文件里的 workflowId 要长期可解析。 */
const EXECUTOR_TABLES: Readonly<Record<string, Readonly<Record<string, NodeExecutor>>>> = Object.freeze({
    [DEV_WORKFLOW.id]: DEV_EXECUTORS,
});

/**
 * 取某节点在 `workflowId` 下的执行者。
 *
 * 三级取法：表里显式声明的 → 按 `actor` 兜底推导 → 都没有则当 `agent`（无名）。
 * **不抛错**：执行者缺失不该让「看实例」这类只读操作失败（它是驱动行为的知识，不是领域事实）；
 * 驱动环自己会对「未知执行者」停下并说明。
 */
export function executorOf(workflowId: string, nodeId: string, actor: Actor | string): NodeExecutor {
    const table = Object.hasOwn(EXECUTOR_TABLES, workflowId) ? EXECUTOR_TABLES[workflowId]! : {};
    const declared = table[nodeId];
    if (declared) return declared;
    if (actor === 'human') return { kind: 'human' };
    if (actor === 'system') return { kind: 'system' };
    return { kind: 'agent', agent: nodeId, role: '' };
}

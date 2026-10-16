// src/main/workflows/index.ts — 宿主的工作流定义注册表（`id → WorkflowDef`，唯一来源）
//
// 为什么是注册表而不是「直接 import 某个定义」：`diy flow` 域按 id 找定义（`start --workflow <id>`），
// 存储文件里记的也是 id（`instance.json.workflowId`）—— 定义与实例之间必须只靠 id 关联，
// 否则「工作流开发包」成熟后换供给方，就得回头改数据文件。
//
// 第一版只有一个内置定义（`workflows/dev.ts`）；加定义 = 加文件 + 在下面注册一行。
// ##341 起，本注册表还**转出「执行者绑定」的取法**（`executors.ts`）—— 定义说「哪一类主体推得动」，
// 执行者表说「到底谁去干」，两者都按定义 id 关联，故同住这一层。

import type { WorkflowDef } from '@diy/flow';
import { DEV_WORKFLOW } from './dev';

export { executorOf } from './executors';
export type { NodeExecutor } from './executors';

/** 已注册的定义（键 = 定义自己的 `id`）。**只增不改**：实例文件里的 workflowId 要能长期解析。 */
const WORKFLOWS: Readonly<Record<string, WorkflowDef<string>>> = Object.freeze({
    [DEV_WORKFLOW.id]: DEV_WORKFLOW as WorkflowDef<string>,
});

/** 按 id 取定义；未知 id → null（调用方负责把「有哪些 id」写进错误消息） */
export function workflowById(id: string): WorkflowDef<string> | null {
    return Object.hasOwn(WORKFLOWS, id) ? WORKFLOWS[id]! : null;
}

/** 全部已注册 id（错误消息 / `diy flow list` 用） */
export function workflowIds(): string[] {
    return Object.keys(WORKFLOWS);
}

/** 清单视图（共享的只读投影：id / 显示名 / 入口 / 节点数 / 边数） */
export interface WorkflowSummary {
    readonly id: string;
    readonly name: string;
    readonly entry: string;
    readonly nodes: number;
    readonly edges: number;
}

export function listWorkflows(): WorkflowSummary[] {
    return Object.values(WORKFLOWS).map((def) => ({
        id: def.id,
        name: def.name,
        entry: def.entry,
        nodes: def.nodes.length,
        edges: def.edges.length,
    }));
}

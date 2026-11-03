// src/main/services/flow-prompt.ts — 「按当前节点装配提示词」（`diy flow prompt` 的只读命令）
//
// 为什么单独一个 service 文件、不放进 core/flow.ts：**分层方向**。core 是状态与文件原语
// （core/state.ts / core/task.ts 那一层），services 才是接 RPC 与提示词装配的那层；把
// 「读实例视图 → 拼 globals → 调 prompt-registry 渲染」放在 core 里会让 core 反向依赖 services
// （本仓 core/** 从不 import services/**）。装配实现本身仍只有一处：`renderFlowNodeHint`
// （prompt-registry 的 `renderSystemDsl`，与 system 装配共用同一个引擎）。
//
// 第一版只做「取得到」（owner 口径 §4）：hint 经**内核** `renderHint` 插值（`${节点 id.局部名}`），
// 再交给模版渲染成节；**真注入 agent 系统提示词是后续任务**，本文件不改装配主干、不碰上下文投递。

import { showFlow } from "../core/flow";
import { renderFlowNodeHint } from "./prompt-registry";

/** 装配结果（`flow prompt` 的回执） */
export interface FlowPromptResult {
    readonly uri: string;
    readonly workflowId: string;
    readonly nodeId: string;
    readonly nodeName: string;
    /** 插值后的节点提示（内核 `renderHint` 的产物） */
    readonly hint: string;
    /** 装配出的节（prompt-registry 用 `flow_node_hint` 模版渲染） */
    readonly prompt: string;
    readonly bytes: number;
}

export function flowPrompt(uri: string): FlowPromptResult {
    const view = showFlow(uri);
    if (!view.node) {
        throw new Error(`实例尚未进入工作流（${uri}）：没有「当前节点」，装配不出节点提示`);
    }
    const prompt = renderFlowNodeHint({
        flow: {
            workflowId: view.workflowId,
            workflowName: view.workflowName,
            nodeId: view.node.id,
            nodeName: view.node.name,
            actor: view.node.actor,
            position: view.position ?? "",
            hint: view.node.hint,
        },
    });
    return {
        uri,
        workflowId: view.workflowId,
        nodeId: view.node.id,
        nodeName: view.node.name,
        hint: view.node.hint,
        prompt,
        bytes: Buffer.byteLength(prompt, "utf-8"),
    };
}

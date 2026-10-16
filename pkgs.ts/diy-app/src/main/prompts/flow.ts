// src/main/prompts/flow.ts — 工作流节点提示模版（`diy flow prompt` 用）
//
// 为什么不并进 `defaults.ts` 的 `PROMPT_DEFAULTS`（##319 的一个**主动取舍**，理由在此）：
//   那份清单是**用户可编辑的面** —— `diy template list|get|save|restore` 逐条列出它、支持项目级覆盖、
//   参与 `_system.md` 装配与预算校验（`savePrompt` 的探针也走它）。加一条进清单会**改变既有 CLI 输出**
//   （`template list` 多一项）与 golden 快照（`tests/fixtures/system.golden.txt` 的逐字节快照），
//   而本任务的硬约束是「只新增域与文件，不改既有行为」。故它走**同一套引擎与同一个装配入口**
//   （`services/prompt-registry.ts::renderFlowNodeHint`，与 system 装配共用 `renderSystemDsl`），
//   只是不进那份用户清单 —— 「接既有 prompt-registry」指的是共用装配实现，不是并入用户清单。
//
// 排版遵循引擎硬规则（同 defaults.ts）：控制标记可缩进（不产出字符），**输出文本必须顶格**。

/** 模版 relpath（与 namespace 同形，便于以后若要并进清单时直接迁移） */
export const FLOW_NODE_HINT_RELPATH = 'flow_node_hint.md';

/** 工作流节点提示的模版集（只有一份；`renderSystemDsl` 的 entry 由 relpath 指定） */
export const FLOW_PROMPT_DEFAULTS: Record<string, string> = {
    'flow_node_hint.md': `---
title: 工作流节点提示
desc: 按工作流当前节点装配的提示（diy flow prompt 的产物；不进 _system.md 装配）
version: 1
---
<flow_node workflow="{{flow.workflowId}}" node="{{flow.nodeId}}" node_name="{{flow.nodeName}}" actor="{{flow.actor}}" position="{{flow.position}}">
{{flow.hint}}
</flow_node>
`,
};

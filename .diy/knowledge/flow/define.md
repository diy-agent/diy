---
desc: 工作流定义 DSL 的结构约束：节点/边/泳道/打回/边界
updated: 2026-11-07
---

## bounce-no-node

**打回不新建节点**（##166 §14.2 推论 2）：`kind: 'bounce'` 只是让目标节点**再驻留一次**（`Visit.seq` 递增），边只影响画线与标注、**不改结构**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:42）

## boundary

本包只做内核：不做事件存储 / 状态文件布局 / 参数值来源（归 ##319）、不渲染（归 ##320）、不调度（`notify` 只给回执）、不引入权限机制

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:67）

## id-guard

**唯一保留的结构护栏**：`edges[].from/to` 只能取节点 id 的字面量联合（`defineWorkflow` 的 `const` 元组泛型）—— 打错字 / 回退到泳道**编译期报错**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:43）

## lane-1to1

**泳道 ≡ 节点，1:1**（##311 §一）：无 `lanes` 段，`name` 只是节点自带的泳道显示名

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:41）

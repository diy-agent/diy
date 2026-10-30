// examples/dev.ts — 范例①：开发工作流（6 泳道 · 含一次打回）
//
// 这是「**一个工作流开发包长什么样**」的样板：只用 `@diy-agent/flow` 的**公开 API**（模拟外部包怎么写，
// 不走相对路径摸内核内部）—— 顺带当集成测试的素材（`tests/examples.dev.test.ts`）。
//
// 一个工作流开发包自己要管理的，就三样东西：
//   ① **泳道图**（本文件：`defineWorkflow` 的声明 —— 节点 / 边 / guard / hint / art / params）；
//   ② **插件实现**（`dev.plugins.ts`：引擎查不到的外部世界 —— 读 CI 状态、写合并动作）；
//   ③ **装配**（宿主侧：把 ①② 与注册表拼起来 —— 见测试 `tests/examples.dev.test.ts`）。
// 其余（定义校验 / 单指针推进 / guard 求值 / 打回护栏 / 参数校验 / 状态落盘 / 轨迹投影）全归内核。
//
// 拓扑（##166 §14.3 的开发场景：8 步 / 6 泳道 / 1 次打回）：
//
//     clarify ──▶ design ──▶ implement ──▶ review ──▶ ci ──▶ merge
//                                ▲            │
//                                └─ bounce ───┘     打回**不新建节点**：implement 再驻留一次（`seq = 2`）
//
// guard 的分水岭是**可观测性**（##166 §10.3），不是节点类型 —— 同一张泳道图里两种行为共存：
//   · clarify / design / implement / review（`prompt:` 不可观测）⇒ 引擎判不了，**只能 actor 宣布**，
//     转移本身就是一条发言（那条审计 Event 的 `author` 就是宣布者）；
//   · ci（`pred:ci_green`）/ merge（`action:pr_mergeable`，且是**写**外部世界）⇒ **系统求值、自动转移**，
//     无人发言（审计 Event 的 `author = 'system'`）。

import { defineWorkflow, type WorkflowDef } from '@diy-agent/flow';

/** 泳道 ≡ 节点（1:1）：六个 id 就是六条泳道（也是折线上可能出现的全部节点） */
export const DEV_NODE_IDS = ['clarify', 'design', 'implement', 'review', 'ci', 'merge'] as const;
export type DevNodeId = (typeof DEV_NODE_IDS)[number];

/**
 * ##166 §14.3 的开发轨迹 —— 本范例要端到端复现的那条折线：
 * `clarify → design → implement → review ⟲ implement → review → ci → merge`。
 * `review → implement` 那一步走的是 **bounce 边**（唯一一次打回）。
 */
export const DEV_TRACE = ['clarify', 'design', 'implement', 'review', 'implement', 'review', 'ci', 'merge'] as const;

/** 宿主关联（`Visit.ref`）用的键 —— 内核只透传不解释（`taskUri` / `turnId` / `stepId`… 由宿主自命名） */
export const DEV_REF_KEY = 'taskUri';

export const devWorkflow: WorkflowDef<DevNodeId> = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    nodes: [
        {
            id: 'clarify',
            name: '需求澄清',
            actor: 'agent',
            guard: ['prompt:requirement_clear'],
            hint: '把需求澄清到没有歧义（谁用 / 做什么 / 验收口径是什么），澄清完提交给设计',
        },
        {
            id: 'design',
            name: '设计',
            actor: 'agent',
            guard: ['prompt:design_ready'],
            hint: '产出方案与边界：写进 design.md，方案定下来就提交给开发',
            art: { raw: 'design.md', renderer: 'doc' },
        },
        {
            id: 'implement',
            name: '开发',
            actor: 'agent',
            guard: ['prompt:dev_done'],
            hint: '开发完成 xx 任务，完成后提交给 Review 步骤',
            art: { raw: 'git diff', renderer: 'diff' },
        },
        {
            id: 'review',
            name: 'Review',
            actor: 'agent',
            guard: ['prompt:review_done'],
            hint: '独立复审（评审人：${reviewers}）；P0/P1 打回，最多打回 ${maxBounces} 次，全部有落点则放行',
            art: { raw: 'review.json', renderer: 'table' },
            // 参数层（L2）：**声明写在节点上**，值走数据（宿主 / UI 只改值、不改形）
            params: [
                { name: 'reviewers', type: 'list', label: '评审人', default: ['purple', 'owner'] },
                { name: 'maxBounces', type: 'number', label: '打回上限', default: 2, min: 0, max: 10, unit: '次' },
            ],
        },
        {
            id: 'ci',
            name: 'CI',
            actor: 'system',
            guard: ['pred:ci_green'],
            hint: '跑 ${command}，全绿才推',
            art: { raw: 'ci badge', renderer: 'badge' },
            params: [{ name: 'command', type: 'string', label: 'CI 命令', default: 'npm run ci' }],
        },
        {
            id: 'merge',
            name: '合并',
            actor: 'system',
            guard: ['action:pr_mergeable'],
            hint: 'PR 可合并（无冲突、已批准）则合并 —— 这一步**写**外部世界',
        },
    ],
    // 边只连节点 id（打错字 / 回退到泳道 = 编译期报错）；入口自动推断 = clarify（唯一没有入边的节点）
    edges: [
        { from: 'clarify', to: 'design', kind: 'next' },
        { from: 'design', to: 'implement', kind: 'next' },
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
        { from: 'ci', to: 'merge', kind: 'next' },
    ],
});

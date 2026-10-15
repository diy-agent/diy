// src/main/workflows/dev.ts — 宿主自持的**开发工作流**定义（第一版最小定义）
//
// 为什么宿主持有一份最小定义（##319 owner 口径 §1）：`diy flow` 域第一次进真实系统，
// 需要一个确定、可断言的定义把「存储 + CLI + 提示词装配」串起来。**不 import ##317 的
// `examples/**`**（`@diy/flow` 的 `exports` 只有 `"."`，跨包子路径 import 是 hack）；
// 「工作流开发包」成熟为独立包后，换的只是注册表来源（`workflows/index.ts`），域与存储不动。
//
// 形状与 ##317 范例同形（`defineWorkflow` + 节点/边），内容取 ##311 §二 里那两个参数例子
// （`review.reviewers` / `ci.command`），用来验证「按当前节点取 hint + ctx.params 插值」那条链。
//
// `guard` 一律用 `prompt:`（**不可观测**）：第一版的宿主不注册任何插件，故不能有 `pred:` /
// `action:`（组合期就会 `invalid-def`）。这也让 `status()` 是纯只读的 —— 不会有人误以为
// 「show 报的 pending 是求值过的结果」（可观测 guard 的求值属后续任务）。

import { defineWorkflow } from '@diy/flow';

export const DEV_WORKFLOW = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    // 入口必须显式指明：implement 也有一条 bounce 入边（review → implement），推不出唯一入口
    entry: 'implement',
    nodes: [
        {
            id: 'implement',
            name: '开发',
            actor: 'agent',
            guard: ['prompt:dev_done'],
            hint: '在 worktree 里改完、自测过再宣布提交 Review。',
        },
        {
            id: 'review',
            name: 'Review',
            actor: 'agent',
            guard: ['prompt:review_done'],
            params: [
                { name: 'reviewers', label: '评审人数', type: 'number', default: 1, min: 1, max: 5, unit: '人' },
                { name: 'maxBounces', label: '打回上限', type: 'number', default: 2, min: 0, max: 10, unit: '次' },
            ],
            hint: '按 ${reviewers} 人评审的要求过一遍；不过就打回开发，最多打回 ${maxBounces} 次。',
        },
        {
            id: 'ci',
            name: 'CI',
            actor: 'agent',
            guard: ['prompt:ci_done'],
            params: [{ name: 'command', label: 'CI 命令', type: 'string', default: './sha.sh check' }],
            hint: '跑 `${command}`，绿了才算走完。',
        },
    ],
    edges: [
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
    ],
});

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
// `guard` 一律用 `prompt:`（**不可观测**）：第一版的宿主不注册任何 guard 插件，故不能有 `pred:` /
// `action:`（组合期就会 `invalid-def`）。这也让 `status()` 是纯只读的 —— 不会有人误以为
// 「show 报的 pending 是求值过的结果」（可观测 guard 的求值属后续任务）。
//
// `art`（##337）：每个节点产物的**展示链** `{ raw, renderer, plugin? }`（内核 §14.7）——
// `renderer` 是引擎侧九种通用渲染器之一，`plugin` 是宿主注册的 render 插件名（`workflows/plugins.ts`）。
// `plugin` 留空的**唯一**合法含义是「**raw 本身已经是该 renderer 的 data**」（形状真源 = `@diy/flow`
// 的 `view.ts`：`ViewData<'…'>`；##337 review1 P2-A）：纯文本 raw ≠ `doc` 的 `DocData`（`{ text }`），
// 故文本类节点必须挂 `text` 插件 —— 本定义三个节点都挂了。
// 宿主不画页面（那是 ##320）：这里只声明「这一步的产物长什么样、翻给哪个渲染器」，
// 翻译在 `core/flow.ts::translateArtifact`。

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
            // 产物 = worktree 里改出来的那串改动；raw 是一段 unified diff 文本 ⇒ 交 `patch` 插件翻成 diff
            art: { raw: '一段 unified diff 文本（本步改出来的改动）', renderer: 'diff', plugin: 'patch' },
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
            // 产物 = 评审结论清单（一行一条：结论 / 意见 / 依据）⇒ 交 `records` 插件翻成表
            art: { raw: '评审结论清单（`{ columns?, rows }` 或裸行数组）', renderer: 'table', plugin: 'records' },
        },
        {
            id: 'ci',
            name: 'CI',
            actor: 'agent',
            guard: ['prompt:ci_done'],
            params: [{ name: 'command', label: 'CI 命令', type: 'string', default: './sha.sh check' }],
            hint: '跑 `${command}`，绿了才算走完。',
            // 产物 = 命令原始输出（纯文本）。`doc` 渲染器吃的是 `{ text: string }`，**裸字符串不是它**
            // ⇒ 交 `text` 插件包一层（##337 review1 P2-A：直吃 raw 只在「raw 本身就是该 renderer 的 data」
            // 时才成立 —— 少了这一步，UI 上的 CI 产物永远显示「形状不符」，用户看不到 CI 输出）
            art: { raw: 'CI 命令的原始输出（纯文本）', renderer: 'doc', plugin: 'text' },
        },
    ],
    edges: [
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
    ],
});

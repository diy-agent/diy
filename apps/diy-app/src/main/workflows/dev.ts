// src/main/workflows/dev.ts — 宿主自持的**开发工作流**定义（##341 升级：6 节点形状 + 1 个人工审批点）
//
// 为什么宿主持有一份定义（##319 owner 口径 §1）：`diy flow` 域要进真实系统，需要一个确定、可断言的
// 定义把「存储 + CLI + 提示词装配」串起来。**不 import ##317 的 `examples/**`**（`@diy-agent/flow` 的
// `exports` 只有 `"."`，跨包子路径 import 是 hack）；「工作流开发包」成熟为独立包后，换的只是注册表
// 来源（`workflows/index.ts`），域与存储不动。
//
// ── 形状（##341 交付物 1）：照 ##317 范例的 6 节点，**外加 1 个人工审批点** ──────────────
//
//     clarify ──▶ design ──▶ implement ──▶ review ──▶ ci ──▶ approve ──▶ merge
//                                ▲            │              （human）
//                                └─ bounce ───┘
//
// · `clarify / design / implement / review` = `actor: 'agent'`（`prompt:` 不可观测 ⇒ 由**节点执行器**
//   起一轮 agent、收结论后宣布）—— 谁跑哪个节点见下面的 `DEV_EXECUTORS`；
// · `ci` = `actor: 'system'` + `pred:ci_green`（**读**外部世界：真跑 `ci.command` 看退出码）；
// · `approve` = `actor: 'human'`（**人工审批点**，内核 `ACTORS` 早就含它）：驱动环走到这里**停下等人**，
//   由人 `diy flow advance <uri> --to merge` 宣布 —— 这正是用户要的「除非后面还有人工审批步骤」；
// · `merge` = `actor: 'system'` + `action:pr_mergeable`（**写**外部世界：查 / 合 PR）。
//
// `approve` 是 ##317 六节点里没有的：交付物 1 明确要一个 human 节点，而 ##317 三个 agent + 两个 system
// 里没有位置放它 —— 唯一自然的插法是 ci（CI 绿了）之后、merge（真合）之前。**这是本任务的主动取舍**，
// 回报里写定案。
//
// ── `art`（##337）：每个节点产物的**展示链** `{ raw, renderer, plugin? }`（内核 §14.7）──────
// `raw` 是「这一步的产物长什么样」的**人话说明**（也进 turn 消息的交付约定 —— 执行器照它告诉 agent
// 该产出什么），`plugin` 是宿主注册的「形状翻译」插件（`workflows/plugins.ts`）。
// `plugin` 留空的唯一合法含义是「raw 本身已经是该 renderer 的 data」（形状真源 = 内核 `view.ts`）——
// 纯文本 raw ≠ `doc` 的 `DocData`（`{ text }`），故文本类节点必须挂 `text` 插件。
// `approve` 故意**不声明** `art`：人工审批没有机器产物（意见正文的载体归 ##342），不编一个假产物出来。

import { defineWorkflow } from '@diy-agent/flow';
import type { NodeExecutor } from './index';

export const DEV_WORKFLOW = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    // 入口显式指明：implement 也有一条 bounce 入边（review → implement），推不出唯一入口
    entry: 'clarify',
    nodes: [
        {
            id: 'clarify',
            name: '需求澄清',
            actor: 'agent',
            guard: ['prompt:requirement_clear'],
            hint: '把需求澄清到没有歧义（谁用 / 做什么 / 验收口径），澄清完提交给设计。',
            art: { raw: '需求澄清结论（纯文本）', renderer: 'doc', plugin: 'text' },
        },
        {
            id: 'design',
            name: '设计',
            actor: 'agent',
            guard: ['prompt:design_ready'],
            hint: '产出方案与边界（改动面 / 接口 / 风险），方案定下来就提交给开发。',
            art: { raw: '方案与边界（纯文本）', renderer: 'doc', plugin: 'text' },
        },
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
            // 产物 = 评审结论清单（一行一条）；也吃 `{ columns?, rows }` 或裸行数组 ⇒ 交 `records` 插件翻成表
            art: { raw: '评审结论清单（一行一条：结论 / 意见 / 依据）', renderer: 'table', plugin: 'records' },
        },
        {
            id: 'ci',
            name: 'CI',
            actor: 'system',
            guard: ['pred:ci_green'],
            params: [{ name: 'command', label: 'CI 命令', type: 'string', default: './sha.sh check' }],
            hint: '跑 `${command}`，绿了才算走完。',
            // 产物 = 命令原始输出（纯文本，由 `ci_green` 的事实带回落袋）。`doc` 渲染器吃的是 `{ text }`
            // ⇒ 交 `text` 插件包一层（##337 review1 P2-A：裸字符串不是 `DocData`）
            art: { raw: 'CI 命令的原始输出（纯文本）', renderer: 'doc', plugin: 'text' },
        },
        {
            id: 'approve',
            name: '人工审批',
            actor: 'human',
            guard: ['prompt:approved'],
            hint: '人工审批点：看 CI 结果与各步产物，批了就宣布推进到合并（`diy flow advance <uri> --to merge`，UI 上是「推进」按钮）。',
            // 故意不声明 art：人工审批没有机器产物（意见正文的载体归 ##342）
        },
        {
            id: 'merge',
            name: '合并',
            actor: 'system',
            guard: ['action:pr_mergeable'],
            params: [
                {
                    name: 'command',
                    label: 'PR 查询命令',
                    type: 'string',
                    default: 'gh pr view --json mergeable,state -q .mergeable',
                },
                { name: 'apply', label: '真合并', type: 'boolean', default: false },
            ],
            hint: '查 `${command}`：可合并（`MERGEABLE`）才推；要真合并把「真合并」打开。',
            // 产物 = 查询 / 合并命令的输出（纯文本）—— 「这一步真查 / 真合了什么」的证据留在袋里
            art: { raw: 'PR 查询 / 合并命令的输出（纯文本）', renderer: 'doc', plugin: 'text' },
        },
    ],
    edges: [
        { from: 'clarify', to: 'design', kind: 'next' },
        { from: 'design', to: 'implement', kind: 'next' },
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
        { from: 'ci', to: 'approve', kind: 'next' },
        { from: 'approve', to: 'merge', kind: 'next' },
    ],
});

/**
 * **节点 → 执行者**表（##341 交付物 1 的「agent 节点要能指明哪个 agent」）。
 *
 * 为什么是宿主侧的旁表、而不是内核 `NodeDef` 的字段：`NodeDef` 形状**封闭**
 * （`diy-flow/src/define.ts::parseNode` 的 `noUnknown` 只认 `id/name/actor/guard/hint/art/params`），
 * 加一个 `executor` 字段 = 改内核 —— 本任务硬约束「内核能不碰就不碰」。旁表按**节点 id** 关联，
 * 内核零改动、实例数据零改动（换表 = 换驱动行为，不动定义与状态）。
 *
 * 形状（本任务定案）：
 *   · `agent` —— `agent` 是**执行者标识**（进审计 `author`、进 turn 消息署名），`role` 是**角色定位文本**
 *     （进 turn 消息首部），`persona?` 可选（人物 id / 名 ⇒ 取它的模型作**本轮**覆盖；缺省用任务绑定的人物）。
 *     **绑定粒度 = session**：一个任务一条本地 agent 会话，各节点的轮次都落在它里面
 *     ⇒ 「哪个 agent」的实质差别靠 role 注入表达，用户能在任务页看着工作流跑。
 *   · `human` —— 驱动环**停下等人**（`diy flow advance` 才继续）；
 *   · `system` —— 由系统求值（`pred:` / `action:`）自动推。
 *
 * 表里**缺项**（换成别的定义时）⇒ 按 `node.actor` 兜底推导（见 `workflows/index.ts::executorOf`），
 * 故驱动环对任意定义通用，不写死这一个工作流。
 */
export const DEV_EXECUTORS: Readonly<Record<string, NodeExecutor>> = Object.freeze({
    clarify: {
        kind: 'agent',
        agent: '需求 agent',
        role: '你是本任务的需求澄清 agent：把需求问到没有歧义（谁用 / 做什么 / 验收口径），产出澄清结论。',
    },
    design: {
        kind: 'agent',
        agent: '设计 agent',
        role: '你是本任务的设计 agent：给出方案与边界（改动面 / 接口 / 风险），产出方案说明。',
    },
    implement: {
        kind: 'agent',
        agent: '开发 agent',
        role: '你是本任务的开发 agent：按方案把代码落进 worktree 并自测；自测证据写进结论。',
    },
    review: {
        kind: 'agent',
        agent: '评审 agent',
        role: '你是本任务的评审 agent：独立复审上游改动，先看证据再下结论；P0/P1 必须给出打回意见。',
    },
    ci: { kind: 'system' },
    approve: { kind: 'human' },
    merge: { kind: 'system' },
});

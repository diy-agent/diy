// examples/finance.ts — 范例③：金融选股工作流（7 泳道 · 含一次**系统**打回）
//
// 与范例①（开发）/ 范例②（视频）**同形**：A 层（拓扑 + 提示词）仍是「节点 → 边 → guard / hint / art」。
// 行业差异依旧全落在插件层与形状上：读行情 / 因子 / 回测 / 风控（5 个 guard）、写券商（1 个 action）、
// 六个形状翻译（K 线 / 热力图 / 篮子表 / 净值曲线 / 风控表 / 委托单表）。
//
// ⚠️ 本范例与另两个的**唯一结构差异**：打回是**系统**打的（`risk` 的 guard 全可观测，
// 权重不合格 ⇒ 系统自己走 bounce 回到 `select`）—— 而视频那次打回是**人/agent 宣布**的。
// 同一条泳道图里两种打回共存，正是「可观测性决定谁来推」的另一面（##166 §14.3 结论 3）。
//
// 拓扑（##166 §14.3 的金融场景：10 步 / 7 泳道 / 1 次打回）：
//
//     fetch ─▶ factor ─▶ select ─▶ backtest ─▶ risk ─▶ signoff ─▶ order
//                          ▲                   │
//                          └──── bounce ───────┘      风控不合格 → 系统打回**不新建节点**：select 再驻留一次
//
// 节点 id / guard / art（renderer + 插件名）**逐字对齐**验收基准 `##166` 的 `workflow-trace-sketch.html`
// （`render_bars` / `render_factor` / `render_basket` / `render_equity` / `render_risk` / `render_orders`）——
// demo 是基准，不是重新发明。

import { defineWorkflow, type WorkflowDef } from '@diy/flow';

/** 泳道 ≡ 节点（1:1）：七个 id 就是七条泳道 */
export const FINANCE_NODE_IDS = ['fetch', 'factor', 'select', 'backtest', 'risk', 'signoff', 'order'] as const;
export type FinanceNodeId = (typeof FINANCE_NODE_IDS)[number];

/**
 * ##166 §14.3 的金融轨迹 —— 本范例要端到端复现的那条折线（10 步）：
 * `fetch → factor → select → backtest → risk ⟲ select → backtest → risk → signoff → order`。
 * `risk → select` 那一步走 **bounce 边**（唯一一次打回，且由**系统**发起），于是 `select` / `backtest` / `risk` 各驻留两次。
 */
export const FINANCE_TRACE = [
    'fetch',
    'factor',
    'select',
    'backtest',
    'risk',
    'select',
    'backtest',
    'risk',
    'signoff',
    'order',
] as const;

/** 宿主关联（`Visit.ref`）用的键 —— 内核只透传不解释（与另两个范例同名，宿主自己的命名习惯） */
export const FINANCE_REF_KEY = 'taskUri';

export const financeWorkflow: WorkflowDef<FinanceNodeId> = defineWorkflow({
    id: 'finance',
    name: '金融选股工作流',
    nodes: [
        {
            id: 'fetch',
            name: '数据拉取',
            actor: 'system',
            guard: ['pred:data_complete'],
            hint: '当日行情与财务数据齐备',
            art: {
                raw: 'bars × 5000 支（日线）',
                renderer: 'kline',
                plugin: 'render_bars',
                note: '行情数组 → 引擎的 kline 渲染器（K 线图）',
            },
        },
        {
            id: 'factor',
            name: '因子计算',
            actor: 'system',
            guard: ['pred:factor_ready'],
            hint: '因子矩阵无缺失值',
            art: {
                raw: '因子矩阵（时间 × 因子）',
                renderer: 'heatmap',
                plugin: 'render_factor',
                note: '矩阵 → 引擎的 heatmap 渲染器（热力图）',
            },
        },
        {
            id: 'select',
            name: '策略筛选',
            actor: 'agent',
            guard: ['prompt:select_ok'],
            hint: '解读因子、解释异常、说明为什么这么筛',
            art: {
                raw: 'basket.json（入选 + 理由）',
                renderer: 'table',
                plugin: 'render_basket',
                note: '选股篮子 → 表（含权重与理由）',
            },
        },
        {
            id: 'backtest',
            name: '回测',
            actor: 'system',
            guard: ['pred:backtest_ok'],
            hint: 'sharpe > 1.5 且 maxDD < 0.2',
            art: {
                raw: '净值序列 + 回撤',
                renderer: 'equity',
                plugin: 'render_equity',
                note: '净值序列 → 引擎的 equity 渲染器（净值曲线 + 回撤标注）',
            },
        },
        {
            id: 'risk',
            name: '风控',
            actor: 'system',
            guard: ['pred:weight_ok', 'pred:not_blacklisted'],
            hint: '数组 = 与：单票 ≤ 10% 且不命中黑名单',
            art: {
                raw: '风控检查项',
                renderer: 'table',
                plugin: 'render_risk',
                note: '检查项 → 表（第 1 次驻留时权重项为 ✗，故打回）',
            },
        },
        {
            id: 'signoff',
            name: '人工确认',
            actor: 'human',
            guard: ['prompt:human_ok'],
            hint: '真金白银的最后一关，人工签字',
            art: { raw: '签字记录', renderer: 'badge', note: '签字 → 徽章' },
        },
        {
            id: 'order',
            name: '下单',
            actor: 'system',
            guard: ['action:place_order'],
            hint: '把篮子提交给券商（写外部世界的动作）',
            art: {
                raw: 'broker.submit() 回执',
                renderer: 'table',
                plugin: 'render_orders',
                note: '成交回报 → 委托单表',
            },
        },
    ],
    // 边只连节点 id（打错字 / 回退到泳道 = 编译期报错）；入口自动推断 = fetch（唯一没有入边的节点）
    edges: [
        { from: 'fetch', to: 'factor', kind: 'next' },
        { from: 'factor', to: 'select', kind: 'next' },
        { from: 'select', to: 'backtest', kind: 'next' },
        { from: 'backtest', to: 'risk', kind: 'next' },
        { from: 'risk', to: 'select', kind: 'bounce' },
        { from: 'risk', to: 'signoff', kind: 'next' },
        { from: 'signoff', to: 'order', kind: 'next' },
    ],
});

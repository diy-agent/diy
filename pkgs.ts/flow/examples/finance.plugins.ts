// examples/finance.plugins.ts — 范例③的插件：读外部世界（5 个 guard）+ 写外部世界（1 个 action）+ 形状翻译（6 个 render）
//
// 与视频范例同一套判据（##166 §13.1）：**引擎能枚举的 → 配置；引擎查不到的 → 插件**。
// 行业差异（行情 / 因子 / 回测 / 风控 / 券商）**只体现在这 12 个函数里**，拓扑与提示词一个字没动。
//
// ⚠️ **权限已拍板：不做权限模型**（##318）：`place_order` 一律 **demo / 假数据**（同范例①的 `pr_mergeable`）——
// 回执由 `FinanceFacts.orderRef` 注入，**不碰 fs、不碰网络、不引新依赖**。真要下单是宿主的事（##319+）。
//
// **范例态**：外部事实由 `FinanceFacts` 注入，缺省「都过」；节点产物（raw）由 `FINANCE_NODE_DATA` 供给。
// 测试里把 `weightOk` 先置 `false`（风控打回）再置 `true`（调完权重通过），两条路都跑到。

import type { ActionPlugin, GuardPlugin, PluginRegistry, RenderPlugin } from '@diy-agent/flow';
import type { FinanceNodeId } from './finance';

/** 外部世界的事实（真实现此刻去读行情 / 跑风控 / 连券商；范例用注入的假数据） */
export interface FinanceFacts {
    /** `pred:data_complete` —— 当日数据齐备 */
    readonly dataComplete?: boolean;
    /** `pred:factor_ready` —— 因子矩阵无缺失 */
    readonly factorReady?: boolean;
    /** `pred:backtest_ok` —— sharpe / maxDD 达标 */
    readonly backtestOk?: boolean;
    /** `pred:weight_ok` —— 单票权重 ≤ 10% */
    readonly weightOk?: boolean;
    /** `pred:not_blacklisted` —— 不命中黑名单 */
    readonly notBlacklisted?: boolean;
    /** `action:place_order` —— 委托成没成 */
    readonly orderOk?: boolean;
    /** `action:place_order` —— 券商回执（委托笔数 / 单号） */
    readonly orderRef?: string;
}

// ── 节点产物（raw）：行业知道长什么样，引擎不知道 ──────────────────────────────

/** `render_bars` 的输入：一根日线 */
interface Bar {
    readonly date: string;
    readonly o: number;
    readonly h: number;
    readonly l: number;
    readonly c: number;
}

/** `render_factor` 的输入：因子矩阵（按行铺平，例子里 4 期 × 4 因子） */
interface FactorMatrix {
    readonly value: readonly number[];
}

/** `render_basket` 的输入：入选股 */
interface BasketItem {
    readonly code: string;
    readonly name: string;
    /** 权重（0..1） */
    readonly weight: number;
    readonly why: string;
}

/** `render_risk` 的输入：一项风控检查 */
interface RiskCheck {
    readonly name: string;
    readonly value: string;
    readonly ok: boolean;
}

/** `render_orders` 的输入：一笔成交回报 */
interface Fill {
    readonly code: string;
    readonly qty: number;
    readonly price: number;
    readonly id: string;
}

/**
 * 每个节点交给 `view` 的那份数据（范例态假数据；键 = 节点 id ⇒ 少一个节点当场编译报错）。
 *
 * `risk` 那份是**第 1 次驻留**的检查项（最大单票 18% > 10% ⇒ 系统打回那次）；
 * 第 2 次驻留时权重项为 `9.8% ✓`（那是节点重新产出的一份 raw，形状相同）。
 */
export const FINANCE_NODE_DATA: Readonly<Record<FinanceNodeId, unknown>> = {
    fetch: {
        bars: [
            { date: '2026-10-07', o: 1662, h: 1691, l: 1655, c: 1678 },
            { date: '2026-10-08', o: 1678, h: 1702, l: 1670, c: 1695 },
            { date: '2026-10-09', o: 1695, h: 1699, l: 1668, c: 1676 },
            { date: '2026-10-10', o: 1676, h: 1688, l: 1660, c: 1664 },
            { date: '2026-10-13', o: 1664, h: 1682, l: 1658, c: 1680 },
            { date: '2026-10-14', o: 1680, h: 1698, l: 1674, c: 1688 },
        ] satisfies readonly Bar[],
    },
    factor: {
        value: [0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.2, 0.5, 0.8, 0.95, 0.6, 0.3, 0.2, 0.4, 0.7, 0.85],
    } satisfies FactorMatrix,
    select: {
        basket: [
            { code: '600519', name: '贵州茅台', weight: 0.18, why: '质量因子最高' },
            { code: '000858', name: '五粮液', weight: 0.12, why: '估值修复' },
            { code: '300750', name: '宁德时代', weight: 0.14, why: '动量 + 景气' },
        ] satisfies readonly BasketItem[],
    },
    backtest: {
        nav: [0, 8, 5, 14, 20, 16, 26, 32, 28, 40, 47, 44, 56, 62],
        drawdown: [0, 0, 3, 0, 0, 4, 0, 0, 4, 0, 0, 3, 0, 0],
        markDrawdown: true,
    },
    risk: {
        checks: [
            { name: '最大单票权重', value: '18.0% > 10%', ok: false },
            { name: '黑名单命中', value: '0', ok: true },
            { name: '行业集中度', value: '1.8x', ok: true },
        ] satisfies readonly RiskCheck[],
    },
    signoff: {
        badges: [
            { label: '复核人 张三', tone: 'ok' },
            { label: '风险揭示已读', tone: 'ok' },
            { label: '签字时间 14:32', tone: 'muted' },
        ],
    },
    order: {
        fills: [
            { code: '600519', qty: 100, price: 1682.0, id: '#8801' },
            { code: '300750', qty: 200, price: 214.6, id: '#8802' },
            { code: '000858', qty: 300, price: 142.3, id: '#8803' },
        ] satisfies readonly Fill[],
    },
};

// ── 形状翻译小工具（行业包自带；插件只做「取字段 + 换个形状」，不做视图）────────────────
function takeShape<T extends object>(data: unknown, what: string): T {
    if (typeof data !== 'object' || data === null) throw new Error(`${what}：节点产物应为对象（实得 ${typeof data}）`);
    return data as T;
}

// ── render 槽：六个形状翻译（唯一「需写代码」处，且只翻形状）────────────────────────

/** `render_bars`：日线数组 → `kline`（`t/o/h/l/c` 逐根搬过去） */
const renderBars: RenderPlugin = (data) => {
    const { bars } = takeShape<{ bars: readonly Bar[] }>(data, 'render_bars');
    return {
        renderer: 'kline',
        payload: {
            candles: bars.map((bar) => ({ t: bar.date, o: bar.o, h: bar.h, l: bar.l, c: bar.c })),
        },
    };
};

/** `render_factor`：因子矩阵 → `heatmap`（行业顺手把值归一成 0..1 的着色强度，省得渲染器猜量纲） */
const renderFactor: RenderPlugin = (data) => {
    const matrix = takeShape<FactorMatrix>(data, 'render_factor');
    const values = matrix.value;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    return {
        renderer: 'heatmap',
        payload: {
            cells: values.map((value) => ({
                value,
                tint: span === 0 ? 0.5 : (value - min) / span,
            })),
        },
    };
};

/** `render_basket`：选股篮子 → `table`（代码 / 名称 / 权重 / 理由） */
const renderBasket: RenderPlugin = (data) => {
    const { basket } = takeShape<{ basket: readonly BasketItem[] }>(data, 'render_basket');
    return {
        renderer: 'table',
        payload: {
            columns: ['代码', '名称', '权重', '理由'],
            rows: basket.map((item) => ({
                cells: [item.code, item.name, `${Math.round(item.weight * 100)}%`, item.why],
            })),
        },
    };
};

/** `render_equity`：净值序列 + 回撤 → `equity`（净值曲线 + maxDD 标注） */
const renderEquity: RenderPlugin = (data) => {
    const equity = takeShape<{
        nav: readonly number[];
        drawdown?: readonly number[];
        markDrawdown?: boolean;
    }>(data, 'render_equity');
    return {
        renderer: 'equity',
        payload: { nav: equity.nav, drawdown: equity.drawdown, markDrawdown: equity.markDrawdown },
    };
};

/** `render_risk`：风控检查项 → `table`（过 / 不过由行业给语义色调，配色归引擎） */
const renderRisk: RenderPlugin = (data) => {
    const { checks } = takeShape<{ checks: readonly RiskCheck[] }>(data, 'render_risk');
    return {
        renderer: 'table',
        payload: {
            columns: ['检查项', '实测', '结论'],
            rows: checks.map((check) => ({
                cells: [check.name, check.value, check.ok ? '✓' : '✗'],
                tone: check.ok ? ('ok' as const) : ('danger' as const),
            })),
        },
    };
};

/** `render_orders`：成交回报 → `table`（委托单表） */
const renderOrders: RenderPlugin = (data) => {
    const { fills } = takeShape<{ fills: readonly Fill[] }>(data, 'render_orders');
    return {
        renderer: 'table',
        payload: {
            columns: ['代码', '数量', '价格', '委托号'],
            rows: fills.map((fill) => ({
                cells: [fill.code, `${fill.qty} 股`, `@${fill.price}`, fill.id],
            })),
        },
    };
};

// ── guard / action 槽：读 / 写外部世界 ────────────────────────────────────────

/** 把「过没过 + 不过时的原因」这个小模式收一处（五个 guard 只差名字与原因文案） */
const predicate: (facts: FinanceFacts, key: keyof FinanceFacts, reason: string) => GuardPlugin =
    (facts, key, reason) => () => {
        const pass = facts[key] ?? true;
        return { pass: pass === true, reason: pass === true ? '' : reason };
    };

/** `action:place_order` —— **写**外部世界（真实现调券商 API；范例只回执，**没有权限模型**） */
const placeOrder: (facts: FinanceFacts) => ActionPlugin = (facts) => () => {
    const ok = facts.orderOk ?? true;
    return ok ? { ok, ref: facts.orderRef ?? 'broker#17 fills' } : { ok };
};

/** 本范例的全部插件（工厂：`facts` 注入外部事实，便于测试与真接入替换） */
export function financePlugins(facts: FinanceFacts = {}): {
    renders: Readonly<Record<string, RenderPlugin>>;
    guards: Readonly<Record<string, GuardPlugin>>;
    actions: Readonly<Record<string, ActionPlugin>>;
} {
    return {
        renders: {
            render_bars: renderBars,
            render_factor: renderFactor,
            render_basket: renderBasket,
            render_equity: renderEquity,
            render_risk: renderRisk,
            render_orders: renderOrders,
        },
        guards: {
            data_complete: predicate(facts, 'dataComplete', '当日数据不齐'),
            factor_ready: predicate(facts, 'factorReady', '因子矩阵有缺失'),
            backtest_ok: predicate(facts, 'backtestOk', 'sharpe / maxDD 不达标'),
            weight_ok: predicate(facts, 'weightOk', '单票权重超 10%'),
            not_blacklisted: predicate(facts, 'notBlacklisted', '命中黑名单'),
        },
        actions: { place_order: placeOrder(facts) },
    };
}

/**
 * 把范例插件注册进宿主的注册表 —— **先注册齐，再 `createRuntime`**
 * （组合期就查名字：`pred:not_blacklist` 这种漏注册 / 错字，不必等到「走到那一步」才暴露）。
 */
export function registerFinancePlugins(registry: PluginRegistry, facts: FinanceFacts = {}): PluginRegistry {
    const { renders, guards, actions } = financePlugins(facts);
    for (const [name, plugin] of Object.entries(renders)) registry.register('render', name, plugin);
    for (const [name, plugin] of Object.entries(guards)) registry.register('guard', name, plugin);
    for (const [name, plugin] of Object.entries(actions)) registry.register('action', name, plugin);
    return registry;
}

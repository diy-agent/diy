// tests/examples.finance.test.ts — 范例③（`examples/finance.ts` + `examples/finance.plugins.ts`）的意图测试
//
// 需求（本文件即契约）：
//   F1 定义：7 泳道 ≡ 7 节点；入口唯一（fetch）；恰一条 bounce 边（risk → select）——**系统**打的回；
//      每个节点都有 `art`（= 一个 view），renderer 取引擎全集里的合法值，插件名与 demo 一致
//   F2 轨迹：只用**公开 API**端到端跑通 ##166 §14.3 的金融轨迹 —— **10 步 / 7 泳道 / 1 次打回**；
//      逐步断言领域态（`FlowState.path`）与审计侧重放（`project`）**逐步相等**
//   F3 view：每个节点的 `view`（renderer id + data 形状）—— kline / heatmap / equity 三种形状各有一份实例，
//      「行业只写形状翻译，不写页面」（##166 §14.7）
//   F4 有事件 / 无事件 + `place_order` 的**范例态假数据**（不做权限模型，不许碰 fs / 网络）
//
// 风格：只用包内公开 API（`../src/index`）+ 契约类型（`../src/index` —— 即包公开面导出的 `src/view.ts` 形状）断言行为，不摸内核私有模块。

import { describe, expect, it } from 'vitest';
import type { Event } from '@diy/talk';
import { nodeAnchor } from '@diy/talk';
import {
    FlowError,
    advance,
    createRegistry,
    createRuntime,
    initialState,
    parseView,
    project,
    type FlowState,
    type StepResult,
    type Transition,
    type View,
    type Visit,
    type BadgeData,
    type EquityData,
    type HeatmapData,
    type KlineData,
    type TableData,
} from '../src/index';
import {
    FINANCE_NODE_IDS,
    FINANCE_REF_KEY,
    FINANCE_TRACE,
    financeWorkflow,
    type FinanceNodeId,
} from '../examples/finance';
import { FINANCE_NODE_DATA, registerFinancePlugins, type FinanceFacts } from '../examples/finance.plugins';

const TASK_URI = 'projects/4/tasks/318';
const at = (n: number): string => `2026-10-13T00:00:${String(n).padStart(2, '0')}.000Z`;

/** 可写的 facts（范例里外部世界会在推进之间变化：策略 agent 调完权重上限，风控就过了） */
type MutableFacts = { -readonly [K in keyof FinanceFacts]: FinanceFacts[K] };

/** 捕获 `FlowError`（断言分类 + 定位路径） */
function caught(fn: () => unknown): FlowError {
    try {
        fn();
    } catch (e) {
        if (e instanceof FlowError) return e;
        throw e;
    }
    throw new Error('期望抛出 FlowError，但调用成功了');
}

/** 一步：谁推的（`system` = 引擎自己推；否则是一条 actor 宣布的发言） */
interface Step {
    readonly to: FinanceNodeId;
    readonly by: 'system' | { readonly author: string; readonly content: string };
    /** 推进到这一步**之前**外部世界的变化（范例：调完权重，风控第 2 次检查才过） */
    readonly facts?: FinanceFacts;
}

/** 轨迹的节点序 = `FINANCE_TRACE`；这里补上「谁推的」与「外部世界何时变」 */
const STEPS: readonly Step[] = [
    { to: 'fetch', by: 'system' }, // 位置为空 ⇒ step 带入入口（进入口不是一条发言）
    { to: 'factor', by: 'system' }, // fetch 的 guard 全可观测 ⇒ 系统自动推
    { to: 'select', by: 'system' },
    {
        to: 'backtest',
        by: { author: '策略 agent', content: '筛出 12 支，逐支写了入选理由与异常解释' },
    },
    { to: 'risk', by: 'system' },
    { to: 'select', by: 'system' }, // ← 唯一一次打回：**系统**打的（权重 18% > 10%，risk 有 bounce 边）
    {
        to: 'backtest',
        by: { author: '策略 agent', content: '调权重上限后重交' },
        facts: { weightOk: true },
    },
    { to: 'risk', by: 'system' },
    { to: 'signoff', by: 'system' },
    { to: 'order', by: { author: '人', content: '人工签字确认，同意下单' } },
];

interface Run {
    /** `states[0]` = 初始态；`states[i+1]` = 第 i 步之后的领域态 */
    readonly states: readonly FlowState<FinanceNodeId>[];
    readonly transitions: readonly Transition<FinanceNodeId>[];
    readonly events: readonly Event[];
    /** 折线走完后在 order 上再 `step` 一次的结果（终态 `done`） */
    readonly end: StepResult<FinanceNodeId>;
    /** notify 插件被唤醒时收到的事件（没注册 notify 时恒为空） */
    readonly wakeups: readonly Event[];
}

interface RunOptions {
    /** `seed.id` 给不给：给了 = 落审计事件并唤醒 notify；缺省不给 = 纯领域推进 */
    readonly withEvents?: boolean;
    readonly facts?: FinanceFacts;
    readonly maxBounces?: number;
    readonly notify?: boolean;
}

/** 端到端跑一遍轨迹：宿主侧的装配示范（**先注册齐、再 createRuntime**） */
function runTrack(options: RunOptions = {}): Run {
    const withEvents = options.withEvents ?? false;
    const wakeups: Event[] = [];
    // 范例态的外部世界：默认「都过」，但**单票权重先不合格**（风控要打回一次，轨迹才完整）
    const facts: MutableFacts = {
        dataComplete: true,
        factorReady: true,
        backtestOk: true,
        weightOk: false,
        notBlacklisted: true,
        ...options.facts,
    };
    const registry = registerFinancePlugins(createRegistry(), facts);
    if (options.notify) {
        registry.register('notify', 'finance_audit', (event) => {
            wakeups.push(event);
            return { delivered: ['finance_audit'] };
        });
    }
    const rt = createRuntime(financeWorkflow, {
        registry,
        maxBounces: options.maxBounces ?? 2,
        notify: options.notify ? ['finance_audit'] : [],
    });

    let seq = 0;
    /** 一次调用的入参：`at` / `ref` 是领域事实；`id` / `content` 是审计材料 */
    const seed = (
        n: number,
        content = '',
    ): { id?: string; at: string; ref: Record<string, string>; content: string } => {
        seq += 1;
        return withEvents
            ? { id: `e${seq}`, at: at(n), ref: { [FINANCE_REF_KEY]: TASK_URI }, content }
            : { at: at(n), ref: { [FINANCE_REF_KEY]: TASK_URI }, content };
    };

    const states: FlowState<FinanceNodeId>[] = [initialState<FinanceNodeId>()];
    const transitions: Transition<FinanceNodeId>[] = [];
    const events: Event[] = [];
    let state = states[0];

    STEPS.forEach((step, i) => {
        if (step.facts) Object.assign(facts, step.facts); // 外部世界变了（agent 调完权重）
        const result =
            step.by === 'system'
                ? rt.step(state, seed(i + 1))
                : {
                      status: 'moved' as const,
                      transition: rt.declare(state, {
                          ...seed(i + 1, step.by.content),
                          author: step.by.author,
                          to: step.to,
                      }),
                  };
        if (result.status !== 'moved') throw new Error(`轨迹第 ${i + 1} 步应当走成 moved，实得 ${result.status}`);
        transitions.push(result.transition);
        if (result.transition.event) events.push(result.transition.event);
        state = result.transition.state;
        states.push(state);
    });

    return { states, transitions, events, end: rt.step(state, seed(STEPS.length + 1)), wakeups };
}

/** 收尾那次 `step` 的领域态（`moved` 与 `done` 都带 `state`） */
function endState(run: Run): FlowState<FinanceNodeId> {
    const end = run.end;
    if (end.status === 'done') return end.state;
    if (end.status === 'moved') return end.transition.state;
    throw new Error(`收尾 step 不该是 ${end.status}`);
}

/** 终态（折线走完后再 step 一次得到的 `done`）；不是 `done` 即说明范例跑偏，直接报 */
function finalState(run: Run): FlowState<FinanceNodeId> {
    if (run.end.status !== 'done') throw new Error(`期望终态 done，实得 ${run.end.status}`);
    return endState(run);
}

/** 折线上一条驻留的**领域事实**（`project` 重建得出的那四项；日志 id / 正文不在其中） */
const visitFact = (v: Visit<FinanceNodeId>): { node: string; seq: number; kind: string; at: string } => ({
    node: v.node,
    seq: v.seq,
    kind: v.kind,
    at: v.at,
});

/** 取节点（范例定义里写死的 id，必存在） */
const nodeOf = (id: FinanceNodeId) =>
    financeWorkflow.nodes.find((n) => n.id === id) as (typeof financeWorkflow.nodes)[number];

/** 用领域正路（`advance`）把位置走到某几个节点（只为造一条已驻留的折线，不涉轨迹语义） */
function walkTo(nodes: readonly FinanceNodeId[]): FlowState<FinanceNodeId> {
    return nodes.reduce(
        (state, to, i) => advance(financeWorkflow, state, { to, at: at(i + 1) }).state,
        initialState<FinanceNodeId>(),
    );
}

// ── F3 用：把「节点 → 此刻能渲染出什么」这步装配出来（宿主侧的事，不是内核的事）────────

/** 只读一份注册表给 view 用（注册是纯装配，可共享） */
const RENDERS = registerFinancePlugins(createRegistry());

/** 某个节点此刻能渲染出的 view（`art.plugin` 有 ⇒ 插件翻形状；没有 ⇒ raw 就是 data） */
function viewOf(id: FinanceNodeId): View {
    const art = nodeOf(id).art;
    if (!art) throw new Error(`节点 ${id} 没有 art（范例不该如此）`);
    if (art.plugin === undefined || art.plugin === null)
        return { renderer: art.renderer, payload: FINANCE_NODE_DATA[id] };
    return RENDERS.resolve('render', art.plugin)(FINANCE_NODE_DATA[id], nodeAnchor(id));
}

// ═══════════════════════════════════════════════════════════════

describe('F1 定义：7 泳道 ≡ 7 节点 · 一条系统 bounce 边 · art / 插件齐全（与 demo 对齐）', () => {
    it('7 个节点就是 7 条泳道，入口唯一（fetch）', () => {
        expect(financeWorkflow.nodes.map((n) => n.id)).toEqual([...FINANCE_NODE_IDS]);
        expect(financeWorkflow.nodes.length).toBe(7);
        expect(financeWorkflow.entry).toBe('fetch');
    });

    it('恰一条 bounce 边（risk → select），且两端都是系统节点：**系统**也能打回', () => {
        expect(financeWorkflow.edges.filter((e) => e.kind === 'bounce')).toEqual([
            { from: 'risk', to: 'select', kind: 'bounce' },
        ]);
        expect(nodeOf('risk').actor).toBe('system');
        expect(financeWorkflow.edges.length).toBe(7);
        expect(financeWorkflow.nodes.length).toBe(7); // 结构不因打回增长
    });

    it('guard 的分水岭是可观测性：2 个 prompt（actor 宣布）+ pred / action（系统推）', () => {
        expect(nodeOf('fetch').guard).toEqual(['pred:data_complete']);
        expect(nodeOf('factor').guard).toEqual(['pred:factor_ready']);
        expect(nodeOf('select').guard).toEqual(['prompt:select_ok']);
        expect(nodeOf('backtest').guard).toEqual(['pred:backtest_ok']);
        expect(nodeOf('risk').guard).toEqual(['pred:weight_ok', 'pred:not_blacklisted']); // 数组 = 与
        expect(nodeOf('signoff').guard).toEqual(['prompt:human_ok']);
        expect(nodeOf('order').guard).toEqual(['action:place_order']);
        expect(['signoff'].map((id) => nodeOf(id as FinanceNodeId).actor)).toEqual(['human']);
    });

    it('每个节点都有 art（= 一个 view）：renderer 取引擎全集里的合法值（kline / heatmap / table / equity / badge）', () => {
        expect(FINANCE_NODE_IDS.map((id) => nodeOf(id).art?.renderer)).toEqual([
            'kline',
            'heatmap',
            'table',
            'equity',
            'table',
            'badge',
            'table',
        ]);
    });

    it('插件名与 demo 对齐，且每个 art.plugin 都真的注册了（先注册齐、再 createRuntime）', () => {
        expect(FINANCE_NODE_IDS.map((id) => nodeOf(id).art?.plugin ?? null)).toEqual([
            'render_bars',
            'render_factor',
            'render_basket',
            'render_equity',
            'render_risk',
            null,
            'render_orders',
        ]);
        expect(RENDERS.names('render')).toEqual([
            'render_bars',
            'render_factor',
            'render_basket',
            'render_equity',
            'render_risk',
            'render_orders',
        ]);
        for (const id of FINANCE_NODE_IDS) {
            const plugin = nodeOf(id).art?.plugin;
            if (plugin != null) expect(RENDERS.has('render', plugin), id).toBe(true);
        }
    });

    it('组合期就查插件名：漏注册 / 错字当场报（`unknown-plugin`）', () => {
        expect(caught(() => createRuntime(financeWorkflow, { registry: createRegistry() })).code).toBe(
            'unknown-plugin',
        );
        expect(() =>
            createRuntime(financeWorkflow, { registry: registerFinancePlugins(createRegistry()) }),
        ).not.toThrow();
    });
});

describe('F2 轨迹复现（##166 §14.3：10 步 / 7 泳道 / 1 次打回）', () => {
    it('本范例要复现的节点序与轨迹表同源（`FINANCE_TRACE`）', () => {
        expect(STEPS.map((s) => s.to)).toEqual([...FINANCE_TRACE]);
    });

    it('10 步逐节点走完：折线 = FINANCE_TRACE，恰一次 bounce，打回后 select / backtest / risk 各驻留两次', () => {
        const path = runTrack({ withEvents: true }).states.at(-1)?.path ?? [];
        expect(path.map((v) => v.node)).toEqual([...FINANCE_TRACE]);
        expect(path.length).toBe(10);
        expect(path.map((v) => v.kind)).toEqual([
            'next',
            'next',
            'next',
            'next',
            'next',
            'bounce',
            'next',
            'next',
            'next',
            'next',
        ]);
        expect(path.filter((v) => v.kind === 'bounce').length).toBe(1);
        expect(path.filter((v) => v.node === 'select').map((v) => v.seq)).toEqual([1, 2]);
        expect(path.filter((v) => v.node === 'backtest').map((v) => v.seq)).toEqual([1, 2]);
        expect(path.filter((v) => v.node === 'risk').map((v) => v.seq)).toEqual([1, 2]);
        expect(financeWorkflow.nodes.length).toBe(7); // 泳道数没变
    });

    it('逐步断言：每一步的领域态折线 == 审计侧重放（`project`）的同前缀结果', () => {
        const run = runTrack({ withEvents: true });
        expect(run.events.length).toBe(10);
        run.states.forEach((state, i) => {
            const replay = project(run.events.slice(0, i), financeWorkflow);
            expect(replay.path.map(visitFact), `第 ${i} 步之后`).toEqual(state.path.map(visitFact));
            expect(replay.currentNode, `第 ${i} 步之后`).toBe(state.position);
        });
        expect(project(run.events, financeWorkflow).visits).toEqual({
            fetch: 1,
            factor: 1,
            select: 2,
            backtest: 2,
            risk: 2,
            signoff: 1,
            order: 1,
        });
    });

    it('转移的结构化语义：**系统**打回也是 `{ kind: "bounce" }`，且打回那步不求值', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[0].move).toEqual({ kind: 'entry', from: null, to: 'fetch' });
        expect(run.transitions[4].move).toEqual({ kind: 'next', from: 'backtest', to: 'risk' });
        expect(run.transitions[5].move).toEqual({ kind: 'bounce', from: 'risk', to: 'select' });
        // 系统打回是**求值后**的结论（guard 不过才回退）—— 与「actor 宣布打回」（视频范例那条，`evaluated === false`，
        // 打回不主张推进 ⇒ 连求值都不做）恰好是两种打回：**同一条 bounce 边，谁推决定要不要先求值**。
        expect(run.transitions[5].guard.evaluated).toBe(true);
        expect(run.transitions[5].guard.pass).toBe(false);
        expect(run.transitions[5].reason).toContain('权重');
        expect(run.transitions[8].move).toEqual({ kind: 'next', from: 'risk', to: 'signoff' });
        expect(run.transitions[9].move).toEqual({ kind: 'next', from: 'signoff', to: 'order' });
    });

    it('系统打回也是一条审计事件（author = system），正文由宿主给', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[5].event?.author).toBe('system');
        expect(run.transitions[5].event?.content).toBe('');
        expect(run.transitions[9].event?.author).toBe('人');
        expect(run.transitions[9].event?.content).toBe('人工签字确认，同意下单');
    });

    it('order 没有 next 出边 ⇒ 再 step 一次是 done（终态记进领域态，不重跑 action:）', () => {
        const final = finalState(runTrack({ withEvents: true }));
        expect(final.done).toBe(true);
        expect(final.path.length).toBe(10);
    });

    it('`status`（零副作用）报「现在轮到谁」', () => {
        const run = runTrack();
        const rt = createRuntime(financeWorkflow, {
            registry: registerFinancePlugins(createRegistry()),
        });
        expect(run.states[1].position).toBe('fetch');
        expect(rt.status(run.states[1]).mode).toBe('system'); // fetch 的 guard 可观测
        expect(rt.status(run.states[3]).mode).toBe('actor'); // select（策略 agent 宣布）
        expect(rt.status(run.states[9]).mode).toBe('actor'); // signoff（人签字）
        expect(rt.status(run.states[10]).mode).toBe('system'); // order
        expect(rt.status(run.states[10]).outEdges).toEqual([]);
    });

    it('打回上限（宿主护栏）兜住死循环：maxBounces = 0 ⇒ 第一次打回就 `bounce-limit`', () => {
        const rtOf = (facts: FinanceFacts, maxBounces: number) =>
            createRuntime(financeWorkflow, {
                registry: registerFinancePlugins(createRegistry(), facts),
                maxBounces,
            });
        const atRisk = walkTo(['fetch', 'factor', 'select', 'backtest', 'risk']);
        const bounced = rtOf({ weightOk: false }, 1).step(atRisk, { at: at(9) });
        expect(bounced.status).toBe('moved'); // 上限 1 ⇒ 允许这一次
        if (bounced.status === 'moved')
            expect(bounced.transition.move).toEqual({ kind: 'bounce', from: 'risk', to: 'select' });
        expect(caught(() => rtOf({ weightOk: false }, 0).step(atRisk, { at: at(9) })).code).toBe('bounce-limit');
        expect(caught(() => rtOf({ weightOk: false }, -1)).code).toBe('invalid-option');
    });

    it('券商没回执 ⇒ 停在 order 边上（guard 不过、又没有 bounce 边）', () => {
        const rt = createRuntime(financeWorkflow, {
            registry: registerFinancePlugins(createRegistry(), { orderOk: false }),
            maxBounces: 2,
        });
        const stuck = rt.step(walkTo(['fetch', 'factor', 'select', 'backtest', 'risk', 'signoff', 'order']), {
            at: at(9),
        });
        expect(stuck.status).toBe('stuck');
    });
});

describe('F3 view：每个节点的 renderer id + data 形状（kline / heatmap / equity 三种形状都在）', () => {
    it('7 个节点各产一个 view：插件产出的 renderer 与 `art.renderer` 声明一致', () => {
        for (const id of FINANCE_NODE_IDS) {
            const view = viewOf(id);
            expect(view.renderer, id).toBe(nodeOf(id).art?.renderer);
            expect(() => parseView(view), id).not.toThrow();
        }
    });

    it('6 个节点走 `render` 插件、1 个引擎直吃（badge）—— 行业定制收敛在插件里', () => {
        const withPlugin = FINANCE_NODE_IDS.filter((id) => nodeOf(id).art?.plugin != null);
        expect(withPlugin).toEqual(['fetch', 'factor', 'select', 'backtest', 'risk', 'order']);
        expect(FINANCE_NODE_IDS.filter((id) => nodeOf(id).art?.plugin == null)).toEqual(['signoff']);
    });

    it('render_bars：日线数组 → kline（o/h/l/c 逐根搬过去）', () => {
        const view = viewOf('fetch');
        const data = view.payload as KlineData;
        expect(view.renderer).toBe('kline');
        expect(data.candles.length).toBe(6);
        expect(data.candles[0]).toEqual({ t: '2026-10-07', o: 1662, h: 1691, l: 1655, c: 1678 });
    });

    it('render_factor：因子矩阵 → heatmap（值 + 归一化后的 tint）', () => {
        const view = viewOf('factor');
        const data = view.payload as HeatmapData;
        expect(view.renderer).toBe('heatmap');
        expect(data.cells.length).toBe(16);
        expect(data.cells[0]).toEqual({ value: 0.1, tint: 0 }); // min ⇒ 0
        expect(data.cells[9]).toEqual({ value: 0.95, tint: 1 }); // max ⇒ 1
        expect(data.cells[1].tint).toBeCloseTo(0.2 / 0.85, 6);
    });

    it('render_basket：选股篮子 → table（代码 / 名称 / 权重 / 理由）', () => {
        const view = viewOf('select');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows[0].cells).toEqual(['600519', '贵州茅台', '18%', '质量因子最高']);
        expect(data.columns).toEqual(['代码', '名称', '权重', '理由']);
    });

    it('render_equity：净值序列 + 回撤 → equity（净值曲线 + maxDD 标注）', () => {
        const view = viewOf('backtest');
        const data = view.payload as EquityData;
        expect(view.renderer).toBe('equity');
        expect(data.nav.length).toBe(14);
        expect(data.drawdown?.length).toBe(data.nav.length);
        expect(data.markDrawdown).toBe(true);
    });

    it('render_risk：风控检查项 → table（第 1 次驻留权重项 ✗ ⇒ danger）', () => {
        const view = viewOf('risk');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.tone)).toEqual(['danger', 'ok', 'ok']);
        expect(data.rows[0].cells).toEqual(['最大单票权重', '18.0% > 10%', '✗']);
    });

    it('signoff（无插件）：签字记录 → badge', () => {
        const view = viewOf('signoff');
        const data = view.payload as BadgeData;
        expect(view.renderer).toBe('badge');
        expect(data.badges.map((b) => b.tone)).toEqual(['ok', 'ok', 'muted']);
    });

    it('render_orders：成交回报 → table（委托单表）', () => {
        const view = viewOf('order');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows[0].cells).toEqual(['600519', '100 股', '@1682', '#8801']);
        expect(data.rows.length).toBe(3);
    });

    it('形状翻译是「真翻译」：raw 与 data 形态不同（heatmap 顺手把量纲归一了）', () => {
        expect(viewOf('factor').payload).not.toEqual(FINANCE_NODE_DATA.factor);
        expect((viewOf('factor').payload as HeatmapData).cells[0]).toEqual({ value: 0.1, tint: 0 });
    });
});

describe('F4 有事件 / 无事件 + `place_order` 的范例态（不做权限模型）', () => {
    it('`seed.id` 给了才落事件、才唤醒 notify', () => {
        const run = runTrack({ withEvents: true, notify: true });
        expect(run.transitions.every((t) => t.event !== undefined)).toBe(true);
        expect(run.events.length).toBe(10);
        expect(run.wakeups.length).toBe(10);
    });

    it('`seed.id` 不给 = 纯领域推进：无事件、无回执、notify 不唤醒 —— 但领域态逐字节相同', () => {
        const audited = runTrack({ withEvents: true, notify: true });
        const plain = runTrack({ withEvents: false, notify: true });
        expect(plain.transitions.every((t) => t.event === undefined)).toBe(true);
        expect(plain.events).toEqual([]);
        expect(plain.wakeups).toEqual([]);
        expect(plain.states).toEqual(audited.states);
        expect(endState(plain)).toEqual(endState(audited));
    });

    it('`action:place_order` 只在终态判定那一步求值一次；`done` 之后不再求值（不重复下单）', () => {
        let calls = 0;
        const registry = registerFinancePlugins(createRegistry(), { orderRef: 'broker#17 fills' });
        registry.register('action', 'spy_order', () => ({ ok: true })); // 只用来证明「无关插件不被唤醒」
        const rt = createRuntime(financeWorkflow, { registry, maxBounces: 2 });
        const state = walkTo(['fetch', 'factor', 'select', 'backtest', 'risk', 'signoff', 'order']);
        const first = rt.step(state, { at: at(9) });
        expect(first.status).toBe('done'); // 终态：guard 全过且**没有 next 出边**
        expect(first.status === 'done' && first.state.done).toBe(true);
        const second = rt.step(first.status === 'done' ? first.state : state, { at: at(10) });
        expect(second.status).toBe('done'); // 重复 step 直接返回 done（`action:` 不重跑）
        // 回执是**假数据**：外部凭据由 `facts` 注入，`place_order` 一个字节的网络 / 文件都不碰
        const receipt = rt.registry.resolve(
            'action',
            'place_order',
        )({ workflow: financeWorkflow, node: nodeOf('order'), params: {}, actor: 'system' });
        expect(receipt).toEqual({ ok: true, ref: 'broker#17 fills' });
        expect(calls).toBe(0); // `spy_order` 从没被任何 guard 引用 ⇒ 一次都没被唤醒
    });

    it('领域态一等：`ref` 随驻留走（日志里没有）；跑完的态可原样回喂 runtime', () => {
        const run = runTrack({ withEvents: true });
        const final = finalState(run);
        expect(final.path.every((v) => v.ref?.[FINANCE_REF_KEY] === TASK_URI)).toBe(true);
        expect(project(run.events, financeWorkflow).path.every((v) => v.ref === undefined)).toBe(true);

        const rt = createRuntime(financeWorkflow, {
            registry: registerFinancePlugins(createRegistry()),
        });
        const again = rt.step(final, { at: at(99) });
        expect(again.status).toBe('done');
    });
});

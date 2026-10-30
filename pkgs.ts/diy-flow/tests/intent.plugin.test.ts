// tests/intent.plugin.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 插件槽位 + guard 数组求值 + 转移执行器的「意图测试」（需求级，不描述实现）
//
// 需求定义（本文件即契约，依据 ##315、##166 §10.3/§13.1/§13.2/§14.3、##101 结论四）：
//   R1  五个固定槽位（guard / source / action / render / notify）—— 工作流只能**引用**，不能自创接口
//   R2  注册表：按名注册 / 解析；**未注册即报错**（不许静默降级）；重名不静默覆盖
//   R3  guard 数组 = **与**：全部满足才可转移；求值**短路**（前项失败就不再执行后面的 `action:`）
//   R4  可观测 guard（`pred:` / `action:`）→ 系统求值并**自动转移**，落一条 `author = system` 的 Event
//   R5  不可观测 guard（`prompt:`）→ **只能由 actor 宣布**，**转移本身就是一条 Event**
//       （含次序铁律：`action:` 副作用只跑一次 · 被拒的宣布不动手 · 打回不跑 guard · `author` 不得冒名 `system`）
//   R6  guard 未过 → **停在原位**（「卡住」在边上，##101 结论四）；有 `bounce` 边则 = **打回**
//       （边上的 `when` 是**边的条件**，系统选边与 actor 宣布**两侧共用一套语义**：单出口也照判，
//        宣布时同样判 —— 不满足 = 这条边此刻不可用）
//   R7  死循环护栏：打回上限（`maxBounces`）
//   R8  端到端：开发工作流 8 步含 1 次 actor 打回；金融工作流含 1 次**系统**打回（##166 §14.3）
//   R9  纯内核：不触外部世界 / 不取时间 —— 由 `intent.flow.test.ts` 的 R7 静态把关（它读整个 src/）
//       （另：运行期选项形状封闭 · notify 失败不作废转移 · 插件异常包装成 FlowError）
//
// 测试风格：以 ##166 §14.3/§14.4 的**真实工作流**为素材（开发 / 金融），断言公开 API 的行为与
// 错误码，不断言内部实现；插件全是假实现（真 CI / 真行情接入是 ##319 的事）。
// ═══════════════════════════════════════════════════════════════

import { type Event } from '@diy-agent/talk';
import { describe, expect, it } from 'vitest';
import {
    FlowError,
    SLOTS,
    classifyGuards,
    createRegistry,
    createRuntime,
    defineWorkflow,
    evaluateGuards,
    initialState,
    parseGuardRef,
    parseView,
    project,
    type DeclareRequest,
    type EventSeed,
    type FlowState,
    type PluginContext,
    type PluginRegistry,
    type Runtime,
    type StepResult,
    type Transition,
    type WorkflowDef,
} from '../src/index';

const AT = '2026-10-13T00:00:00.000Z';

/** 取这次转移的审计事件：本文件的驱动器**总是**给 `id`（##333 后事件可选）⇒ 必有 */
function auditOf<Id extends string>(transition: Transition<Id>): Event {
    const event = transition.event;
    if (event === undefined) throw new Error('这次转移应当落了审计事件（驱动器给了 id）');
    return event;
}

/** 捕获错误（断言分类 + 定位路径） */
function caught(fn: () => unknown): FlowError {
    try {
        fn();
    } catch (e) {
        if (e instanceof FlowError) return e;
        throw e;
    }
    throw new Error('期望抛出 FlowError，但调用成功了');
}

let counter = 0;
/** 新事件种子：内核不取时间、不生成 id → 测试自己给 */
function nextSeed(): EventSeed {
    counter += 1;
    return { id: `e${counter}`, at: AT };
}

/** 把「当前位置 + 已落事件」攥在手里的小驱动器，让端到端轨迹读起来就是一条折线 */
function runner<Id extends string>(rt: Runtime<Id>) {
    let state: FlowState<Id> = initialState<Id>();
    const events: Event[] = [];
    function record(transition: Transition<Id>): Transition<Id> {
        state = transition.state;
        events.push(auditOf(transition));
        return transition;
    }
    return {
        step(): Transition<Id> {
            const result = rt.step(state, nextSeed());
            if (result.status !== 'moved') throw new Error(`期望 moved，实得 ${result.status}`);
            return record(result.transition);
        },
        declare(request: Omit<DeclareRequest<Id>, 'id' | 'at'>): Transition<Id> {
            return record(rt.declare(state, { ...nextSeed(), ...request }));
        },
        state(): FlowState<Id> {
            return state;
        },
        events,
    };
}

// ── 假插件：真函数由宿主（各工作流开发包）注册；这里只是开关 + 记账 ─────────────────────

const GUARD_NAMES = [
    'check_green',
    'intent_green',
    'ci_green',
    'no_conflict',
    'review_approved',
    'data_complete',
    'factor_ready',
    'backtest_ok',
    'weight_ok',
    'not_blacklisted',
] as const;

const ACTION_NAMES = ['publish', 'place_order'] as const;

interface Fakes {
    readonly registry: PluginRegistry;
    /** 每个 guard 的开关（缺省全绿）—— 测试按需拨红 */
    readonly flags: Map<string, boolean>;
    /** 调用流水（断言「谁被求值了 / 谁没被执行」） */
    readonly calls: string[];
}

function fakes(): Fakes {
    const flags = new Map<string, boolean>(GUARD_NAMES.map((name) => [name, true]));
    const calls: string[] = [];
    const registry = createRegistry();

    for (const name of GUARD_NAMES) {
        registry.register('guard', name, (ctx: PluginContext) => {
            calls.push(`${name}@${ctx.node.id}`);
            const pass = flags.get(name) ?? true;
            return pass ? { pass } : { pass, reason: `${name} 未过` };
        });
    }
    for (const name of ACTION_NAMES) {
        registry.register('action', name, (ctx: PluginContext) => {
            calls.push(`action:${name}@${ctx.node.id}`);
            return { ok: true, ref: `${name}#1` };
        });
    }
    registry.register('source', 'quotes', (ctx) => ({ node: ctx.node.id, bars: 5000 }));
    registry.register('render', 'bars', (data, anchor) => ({ renderer: 'kline', payload: { data, anchor } }));
    registry.register('notify', 'wake', (event) => ({ delivered: [event.author], note: event.id }));

    return { registry, flags, calls };
}

// ── 工作流定义（##166 §14.3：开发 6 节点 / 金融 7 节点）─────────────────────────────

const devDef = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    nodes: [
        { id: 'clarify', name: '需求', actor: 'human', guard: ['prompt:clear_enough'], hint: '澄清到无歧义即可放行' },
        { id: 'design', name: '设计', actor: 'agent', guard: ['prompt:design_ready'], hint: '产出方案与边界' },
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '开发完成 xx 任务，完成后提交给 Review 步骤' },
        { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '独立复审；P0/P1 打回，全部有落点则放行' },
        { id: 'ci', name: 'CI', actor: 'system', guard: ['pred:check_green', 'pred:intent_green'], hint: '数组 = 与：两套检查都绿才推' },
        { id: 'merge', name: '合并', actor: 'system', guard: ['pred:ci_green', 'pred:no_conflict', 'pred:review_approved'], hint: '三条 guard 全满足' },
    ],
    edges: [
        { from: 'clarify', to: 'design', kind: 'next' },
        { from: 'design', to: 'implement', kind: 'next' },
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
        { from: 'ci', to: 'merge', kind: 'next' },
    ],
});

const quantDef = defineWorkflow({
    id: 'quant',
    name: '金融选股工作流',
    nodes: [
        { id: 'fetch', name: '数据', actor: 'system', guard: ['pred:data_complete'], hint: '行情与财务数据齐备' },
        { id: 'factor', name: '因子', actor: 'system', guard: ['pred:factor_ready'], hint: '因子矩阵无缺失值' },
        { id: 'select', name: '筛选', actor: 'agent', guard: ['prompt:select_ok'], hint: '解读因子、说明为什么这么筛' },
        { id: 'backtest', name: '回测', actor: 'system', guard: ['pred:backtest_ok'], hint: 'sharpe > 1.5 且 maxDD < 0.2' },
        { id: 'risk', name: '风控', actor: 'system', guard: ['pred:weight_ok', 'pred:not_blacklisted'], hint: '单票 ≤ 10% 且不命中黑名单' },
        { id: 'signoff', name: '人工确认', actor: 'human', guard: ['prompt:human_ok'], hint: '真金白银的最后一关，人工签字' },
        { id: 'order', name: '下单', actor: 'system', guard: ['action:place_order'], hint: '把篮子提交给券商' },
    ],
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

/** 两个纯系统节点：guard 数组全可观测 → 引擎自决 */
const pairDef = defineWorkflow({
    id: 'pair',
    nodes: [
        { id: 'a', name: 'A', actor: 'system', guard: ['pred:check_green', 'pred:intent_green'], hint: '两条都要绿' },
        { id: 'b', name: 'B', actor: 'system', guard: [], hint: '终态' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
});

/** 守卫 + 副作用：`action:` 是写外部世界的，不能在已知前项失败后仍然执行 */
const sideFxDef = defineWorkflow({
    id: 'side-fx',
    nodes: [
        { id: 'go', name: '放行并下单', actor: 'system', guard: ['pred:check_green', 'action:place_order'], hint: '先判再动手' },
        { id: 'end', name: '终态', actor: 'system', guard: [], hint: '' },
    ],
    edges: [{ from: 'go', to: 'end', kind: 'next' }],
});

/** 打回环：work ⇄ check（双向环 → 入口须显式给，##313 的 no-entry） */
const loopDef = defineWorkflow({
    id: 'loop',
    entry: 'work',
    nodes: [
        { id: 'work', name: '干活', actor: 'agent', guard: ['prompt:work_done'], hint: '' },
        { id: 'check', name: '检查', actor: 'agent', guard: ['prompt:check_ok'], hint: '' },
    ],
    edges: [
        { from: 'work', to: 'check', kind: 'next' },
        { from: 'check', to: 'work', kind: 'bounce' },
    ],
});

/** 一个闸门两个出口：系统节点多出口时用边上的 `when` 消歧 */
const branchDef = defineWorkflow({
    id: 'branch',
    nodes: [
        { id: 'gate', name: '闸门', actor: 'system', guard: ['pred:check_green'], hint: '' },
        { id: 'left', name: '左', actor: 'system', guard: [], hint: '' },
        { id: 'right', name: '右', actor: 'system', guard: [], hint: '' },
    ],
    edges: [
        { from: 'gate', to: 'left', kind: 'next', when: 'pred:ci_green' },
        { from: 'gate', to: 'right', kind: 'next', when: 'pred:no_conflict' },
    ],
});

/** 混合节点：可观测（`action:`）+ 不可观测（`prompt:`）→ 只能由 actor 宣布；另带一条打回边 */
const mixedActionDef = defineWorkflow({
    id: 'mixed-action',
    entry: 'ship',
    nodes: [
        { id: 'ship', name: '发布', actor: 'agent', guard: ['action:publish', 'prompt:shipped'], hint: '' },
        { id: 'end', name: '终态', actor: 'system', guard: [], hint: '' },
        { id: 'back', name: '退回', actor: 'human', guard: ['prompt:retry'], hint: '' },
    ],
    edges: [
        { from: 'ship', to: 'end', kind: 'next' },
        { from: 'ship', to: 'back', kind: 'bounce' },
    ],
});

/** 唯一一条出边，但边上写了 `when` —— 边的条件，单出口也算数 */
const gateDef = defineWorkflow({
    id: 'gate',
    entry: 'gate',
    nodes: [
        { id: 'gate', name: '闸门', actor: 'system', guard: ['pred:check_green'], hint: '' },
        { id: 'down', name: '下游', actor: 'system', guard: [], hint: '' },
    ],
    edges: [{ from: 'gate', to: 'down', kind: 'next', when: 'pred:no_conflict' }],
});

type IdOf<W> = W extends WorkflowDef<infer Id> ? Id : never;

// ═══════════════════════════════════════════════════════════════

describe('R1 五个固定槽位（工作流只能引用，不能自创接口）', () => {
    it('槽位全集由引擎枚举', () => {
        expect(SLOTS).toEqual(['guard', 'source', 'action', 'render', 'notify']);
    });

    it('五个槽各注册一个真函数，都能解析', () => {
        const { registry } = fakes();
        expect(registry.has('guard', 'check_green')).toBe(true);
        expect(registry.names('guard')).toContain('weight_ok');
        expect([...registry.names('action')]).toEqual(['publish', 'place_order']);
        for (const slot of SLOTS) {
            expect(registry.names(slot).length, `${slot} 槽应有已注册项`).toBeGreaterThan(0);
        }
    });

    it('`render` 槽只做形状翻译：raw → 引擎通用渲染器（不写页面）', () => {
        const { registry } = fakes();
        const view = parseView(registry.resolve('render', 'bars')([1, 2, 3], { type: 'node', data: { nodeId: 'n' } }));
        expect(view.renderer).toBe('kline');
        expect(view.payload).toEqual({ data: [1, 2, 3], anchor: { type: 'node', data: { nodeId: 'n' } } });
        // 非引擎通用渲染器（自造页面）→ 立即报错
        expect(caught(() => parseView({ renderer: 'my-own-page', payload: {} })).code).toBe('invalid-plugin-result');
    });
});

describe('R2 注册表：未注册即报错（不许静默降级）', () => {
    it('解析未注册的插件 → unknown-plugin（绝不返回 undefined 让调用方漏判）', () => {
        const e = caught(() => createRegistry().resolve('guard', 'nope'));
        expect(e.code).toBe('unknown-plugin');
        expect(e.path).toBe('guard:nope');
    });

    it('重名注册 → duplicate-plugin（不静默覆盖）', () => {
        const registry = createRegistry().register('guard', 'same', () => ({ pass: true }));
        const e = caught(() => registry.register('guard', 'same', () => ({ pass: false })));
        expect(e.code).toBe('duplicate-plugin');
        expect(registry.resolve('guard', 'same')({} as PluginContext).pass).toBe(true);
    });

    it('空名 / 非函数 → invalid-plugin', () => {
        expect(caught(() => createRegistry().register('guard', '', () => ({ pass: true }))).code).toBe('invalid-plugin');
        // @ts-expect-error 非函数不是插件
        expect(caught(() => createRegistry().register('guard', 'x', 42)).code).toBe('invalid-plugin');
    });

    it('工作流里引用了没注册的 guard 名字 → 求值时报错，**不当成「不通过」糊过去**', () => {
        const ctx: PluginContext = { workflow: pairDef, node: pairDef.nodes[0], params: {}, actor: 'system' };
        expect(caught(() => evaluateGuards(['pred:ci_grenn'], ctx, createRegistry())).code).toBe('unknown-plugin');
    });

    it('组合期就报：错字不必等到「走到那一步」才暴露（`guard` / `when` / `notify` 全是静态可枚举的名字）', () => {
        const { registry } = fakes();
        const typo = defineWorkflow({
            id: 'typo',
            nodes: [{ id: 'solo', name: '单', actor: 'system', guard: ['pred:ci_grenn'], hint: '' }],
            edges: [],
        });
        const e = caught(() => createRuntime(typo, { registry }));
        expect(e.code).toBe('unknown-plugin');
        expect(e.path).toBe('nodes[0].guard[0]');
        expect(e.message).toContain('check_green'); // 已注册的名字列出来，好改错字

        // 边上的 `when` 与 `notify` 同样静态可查
        expect(caught(() => createRuntime(gateDef, { registry, notify: ['nope'] })).path).toBe('notify[0]');
        const badWhen = defineWorkflow({
            id: 'bad-when',
            entry: 'a',
            nodes: [
                { id: 'a', name: 'A', actor: 'system', guard: [], hint: '' },
                { id: 'b', name: 'B', actor: 'system', guard: [], hint: '' },
            ],
            edges: [{ from: 'a', to: 'b', kind: 'next', when: 'pred:nope' }],
        });
        expect(caught(() => createRuntime(badWhen, { registry })).path).toBe('edges[0].when');
        // `prompt:` 不是插件名（本来就不注册）→ 不查（用一个**真含 `prompt:`** 的定义来验，别空转）
        const promptOnly = defineWorkflow({
            id: 'prompt-only',
            nodes: [{ id: 'only', name: '单', actor: 'agent', guard: ['prompt:没人注册的提示词'], hint: '' }],
            edges: [],
        });
        expect(() => createRuntime(promptOnly, { registry })).not.toThrow();
    });

    it('定义矛盾：`actor: system` 却带不可观测 guard → 组合期 invalid-def（不留到运行期静默卡死）', () => {
        const { registry } = fakes();
        // 系统判不了（prompt:）、actor 又不得宣布（not-declarable）⇒ 谁也推不动 = 死锁
        const deadlock = defineWorkflow({
            id: 'deadlock',
            entry: 'wait',
            nodes: [
                { id: 'wait', name: '等外部系统', actor: 'system', guard: ['prompt:external_done'], hint: '' },
                { id: 'down', name: '下游', actor: 'system', guard: [], hint: '' },
            ],
            edges: [{ from: 'wait', to: 'down', kind: 'next' }],
        });
        const e = caught(() => createRuntime(deadlock, { registry }));
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('nodes[0]');
        expect(e.message).toContain('external_done');
    });
});

describe('R3 guard 数组 = 与（全部满足才可转移；短路）', () => {
    it('空数组 = 恒真（无需判据即可离开）', () => {
        const { registry } = fakes();
        const status = createRuntime(pairDef, { registry }).status(initialState<IdOf<typeof pairDef>>());
        expect(status.mode).toBe('entry'); // 未进入时还没有判据可谈
        const rt = createRuntime(pairDef, { registry });
        const r = runner(rt);
        r.step(); // 进入入口 a
        const moved = r.step(); // a → b（check_green ✓ intent_green ✓）
        expect(moved.guard.checks.map((c) => c.ref.raw)).toEqual(['pred:check_green', 'pred:intent_green']);
    });

    it('一条 pred 未过 → 不可转移（停在原位）', () => {
        const { registry, flags, calls } = fakes();
        flags.set('intent_green', false);
        const rt = createRuntime(pairDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 a
        const result = rt.step(r.state(), nextSeed());
        expect(result.status).toBe('stuck');
        if (result.status !== 'stuck') throw new Error('unreachable');
        expect(result.reason).toContain('intent_green');
        expect(result.guard.pass).toBe(false);
        // 与语义：前一条也求过值（不是因为「短路到第一条」）
        expect(calls).toEqual(['check_green@a', 'intent_green@a']);
    });

    it('短路：前项失败后不再执行后面的 `action:`（它有副作用）', () => {
        const { registry, flags, calls } = fakes();
        flags.set('check_green', false);
        const rt = createRuntime(sideFxDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 go
        const result = rt.step(r.state(), nextSeed());
        expect(result.status).toBe('stuck');
        expect(calls).toEqual(['check_green@go']); // 下单动作一次都没跑
    });

    it('全部满足 → 一并求值（含 action）', () => {
        const { registry, calls } = fakes();
        const rt = createRuntime(sideFxDef, { registry });
        const r = runner(rt);
        r.step();
        const moved = r.step();
        expect(moved.guard.pass).toBe(true);
        expect(calls).toEqual(['check_green@go', 'action:place_order@go']);
        expect(auditOf(moved).anchor).toEqual({ type: 'node', data: { nodeId: 'end' } });
    });
});

describe('R4 可观测 guard → 系统求值并自动转移（author = system）', () => {
    it('事件 author = system、锚点指向目标节点；语义（kind / from / to）走 `move`，内核不编人类文本', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const r = runner(rt);
        r.step(); // clarify
        r.declare({ author: 'human', to: 'design', content: '需求无歧义' });
        r.declare({ author: '设计 agent', to: 'implement', content: '方案定了' });
        r.declare({ author: '开发 agent', to: 'review', content: '开发完成' });
        r.declare({ author: 'Review agent', to: 'ci', content: '放行 CI' });
        const moved = r.step(); // ci：全 pred → 系统自己求值、自己推

        expect(auditOf(moved).author).toBe('system');
        expect(auditOf(moved).anchor).toEqual({ type: 'node', data: { nodeId: 'merge' } });
        expect(moved.move).toEqual({ kind: 'next', from: 'ci', to: 'merge' });
        expect(moved.reason).toBe('');
        expect(moved.guard.mode).toBe('system');
        expect(moved.state.position).toBe('merge');
    });

    it('终态节点：guard 全过但没有 next 出边 → done（不是异常）', () => {
        const { registry } = fakes();
        const rt = createRuntime(pairDef, { registry });
        const r = runner(rt);
        r.step(); // a
        r.step(); // a → b
        expect(rt.step(r.state(), nextSeed()).status).toBe('done');
    });

    it('终态节点的 guard **要**求值（`action:` 的求值就是「下单」）；`done` 后重复 `step` 会重跑 ⇒ 轮询用 `status()`', () => {
        const { registry, calls } = fakes();
        const terminal = defineWorkflow({
            id: 'terminal-action',
            entry: 'go',
            nodes: [{ id: 'go', name: '放行并下单', actor: 'system', guard: ['action:place_order'], hint: '' }],
            edges: [],
        });
        const rt = createRuntime(terminal, { registry });
        const r = runner(rt);
        r.step(); // 进入 go
        expect(rt.step(r.state(), nextSeed()).status).toBe('done');
        // 「先判终态、再求值」= 订单永不提交 —— 终态 guard 的求值就是对外部世界动手那一下
        expect(calls).toEqual(['action:place_order@go']);
        expect(rt.status(r.state()).mode).toBe('system'); // 只读查询不调插件（零副作用）
        expect(calls).toEqual(['action:place_order@go']);
        // 已知边界（契约兜）：同一个 state 再 step 会再推一次 ⇒ ① `action:` 插件须幂等 ② 轮询用 status()
        expect(rt.step(r.state(), nextSeed()).status).toBe('done');
        expect(calls).toEqual(['action:place_order@go', 'action:place_order@go']);
    });
});

describe('R5 不可观测 guard → 只能由 actor 宣布，转移本身就是一条 Event', () => {
    it('step 遇到 `prompt:` 只回报「等 actor」，不替它决定', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const r = runner(rt);
        r.step(); // 进入入口 clarify（human 的 prompt 节点）
        const result: StepResult<IdOf<typeof devDef>> = rt.step(r.state(), nextSeed());
        expect(result.status).toBe('awaiting-actor');
        if (result.status !== 'awaiting-actor') throw new Error('unreachable');
        expect(result.pending.map((ref) => ref.raw)).toEqual(['prompt:clear_enough']);
    });

    it('actor 宣布 = 一条 Event（author = 宣布者，正文 = 宣布语）', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const r = runner(rt);
        r.step();
        const declared = r.declare({ author: 'human', to: 'design', content: '需求已澄清，交设计' });
        expect(auditOf(declared).author).toBe('human');
        expect(auditOf(declared).content).toBe('需求已澄清，交设计');
        expect(auditOf(declared).anchor).toEqual({ type: 'node', data: { nodeId: 'design' } });
        expect(declared.move).toEqual({ kind: 'next', from: 'clarify', to: 'design' });
        expect(declared.guard.mode).toBe('actor');
        expect(declared.guard.pending.map((ref) => ref.raw)).toEqual(['prompt:clear_enough']);
        expect(declared.state.position).toBe('design');
    });

    it('可观测节点（guard 全 pred）不许 actor 宣布 —— 系统节点由系统推', () => {
        const { registry } = fakes();
        const rt = createRuntime(pairDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 a
        const e = caught(() => rt.declare(r.state(), { ...nextSeed(), author: 'agent', to: 'b', content: '我说过了' }));
        expect(e.code).toBe('not-declarable');
    });

    it('宣布「推进」而可观测那部分不过 → guard-failed（actor 只能替自己判，不能替系统判）', () => {
        const mixed = defineWorkflow({
            id: 'mixed',
            nodes: [
                { id: 'impl', name: '开发', actor: 'agent', guard: ['pred:ci_green', 'prompt:dev_done'], hint: '' },
                { id: 'next', name: '下一步', actor: 'agent', guard: ['prompt:x'], hint: '' },
            ],
            edges: [{ from: 'impl', to: 'next', kind: 'next' }],
        });
        const { registry, flags } = fakes();
        flags.set('ci_green', false);
        const rt = createRuntime(mixed, { registry });
        const r = runner(rt);
        r.step();
        const e = caught(() => r.declare({ author: '开发 agent', to: 'next', content: '我做完了' }));
        expect(e.code).toBe('guard-failed');
        expect(e.message).toContain('ci_green');
    });

    it('宣布「打回」不主张推进 → 不设闸门（可观测那部分不过也允许）', () => {
        const { registry, flags } = fakes();
        flags.set('ci_green', false);
        const mixed = defineWorkflow({
            id: 'mixed2',
            entry: 'impl',
            nodes: [
                { id: 'impl', name: '开发', actor: 'agent', guard: ['pred:ci_green', 'prompt:dev_done'], hint: '' },
                { id: 'up', name: '上游', actor: 'human', guard: ['prompt:up_ok'], hint: '' },
            ],
            edges: [
                { from: 'impl', to: 'up', kind: 'bounce' },
                { from: 'up', to: 'impl', kind: 'next' },
            ],
        });
        const rt = createRuntime(mixed, { registry });
        const r = runner(rt);
        r.step();
        const bounced = r.declare({ author: '开发 agent', to: 'up', content: '这个需求我做不到，打回' });
        expect(auditOf(bounced).anchor).toEqual({ type: 'node', data: { nodeId: 'up' } });
        expect(bounced.move).toEqual({ kind: 'bounce', from: 'impl', to: 'up' });
        expect(bounced.state.path[1].kind).toBe('bounce');
    });

    it('`action:` 副作用只跑一次：含 `prompt:` 的节点，`step` 一个插件都不调，动手只落在 `declare`', () => {
        const { registry, calls } = fakes();
        const rt = createRuntime(mixedActionDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 ship
        expect(rt.step(r.state(), nextSeed()).status).toBe('awaiting-actor');
        expect(calls).toEqual([]); // 系统还没动手（否则 declare 时会再来一次 = 同一件事做两遍）
        r.declare({ author: '发布 agent', to: 'end', content: '发布完成' });
        expect(calls).toEqual(['action:publish@ship']); // 只跑一次
    });

    it('被拒的 `declare` 不动手：系统节点上宣布 → not-declarable，且一个插件都没跑', () => {
        const { registry, calls } = fakes();
        const rt = createRuntime(sideFxDef, { registry }); // go: ['pred:check_green', 'action:place_order']
        const r = runner(rt);
        r.step(); // 进入 go
        const e = caught(() => rt.declare(r.state(), { ...nextSeed(), author: 'agent', to: 'end', content: '我说了算' }));
        expect(e.code).toBe('not-declarable');
        expect(calls).toEqual([]); // 先拒单，后求值 —— 不能先下了单再报「不允许」
    });

    it('打回声明不跑 guard：`action:` 不该因为「有人往后退」而动手', () => {
        const { registry, calls } = fakes();
        const rt = createRuntime(mixedActionDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 ship
        const bounced = r.declare({ author: '发布 agent', to: 'back', content: '环境不对，先退回' });
        expect(calls).toEqual([]); // 打回不主张推进 → 连求值都不做
        expect(bounced.guard.evaluated).toBe(false);
        expect(bounced.guard.pass).toBe(true); // 「没有闸门」，不是「条件满足了」
        expect(bounced.state.path[1].kind).toBe('bounce');
    });

    it('`author` 不得冒名内核保留字 `system`（否则下游分不清「系统推」与「谁宣布推」）', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const r = runner(rt);
        r.step(); // clarify
        const e = caught(() => r.declare({ author: 'system', to: 'design', content: '我说了算' }));
        expect(e.code).toBe('invalid-declare');
        expect(e.path).toBe('request.author');
        expect(caught(() => r.declare({ author: '', to: 'design', content: '' })).code).toBe('invalid-declare');
        expect(r.state().position).toBe('clarify'); // 位置没动
    });
});

describe('R6 guard 未过：停在边上 / 打回', () => {
    it('无 bounce 边 → 停在原位（「卡住」在边上，不在节点上）', () => {
        const { registry, flags } = fakes();
        flags.set('data_complete', false);
        const rt = createRuntime(quantDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 fetch
        const result = rt.step(r.state(), nextSeed());
        expect(result.status).toBe('stuck');
        if (result.status !== 'stuck') throw new Error('unreachable');
        expect(result.reason).toContain('data_complete');
        expect(r.state().position).toBe('fetch'); // 位置没动
    });

    it('有 bounce 边 → 系统打回（也是一条 author = system 的 Event）', () => {
        const { registry, flags } = fakes();
        flags.set('weight_ok', false);
        const rt = createRuntime(quantDef, { registry });
        const r = runner(rt);
        r.step(); // 进入入口 fetch
        r.step(); // fetch → factor
        r.step(); // factor → select
        r.declare({ author: '筛选 agent', to: 'backtest', content: '因子解读完成，交回测' });
        r.step(); // backtest → risk
        const bounced = r.step(); // risk：权重不合格 → 打回 select

        expect(auditOf(bounced).author).toBe('system');
        expect(auditOf(bounced).anchor).toEqual({ type: 'node', data: { nodeId: 'select' } });
        expect(bounced.move).toEqual({ kind: 'bounce', from: 'risk', to: 'select' });
        expect(bounced.reason).toContain('weight_ok');
        expect(bounced.state.path[bounced.state.path.length - 1].kind).toBe('bounce');
        expect(bounced.state.position).toBe('select');
    });

    it('系统节点多出口：when 命中唯一一条；命中数不为 1 → ambiguous-edge', () => {
        const { registry, flags } = fakes();
        const rt = createRuntime(branchDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 gate
        flags.set('ci_green', false);
        r.step(); // ci_green ✗ / no_conflict ✓ → 唯一命中 right
        expect(r.state().position).toBe('right');

        const { registry: reg2 } = fakes();
        const rt2 = createRuntime(branchDef, { registry: reg2 });
        const r2 = runner(rt2);
        r2.step(); // 进入 gate（两个 when 都真）
        expect(caught(() => rt2.step(r2.state(), nextSeed())).code).toBe('ambiguous-edge');
    });

    it('唯一一条出边上的 `when` 也算数：不满足 = 这条边此刻不可用 → 停在原位', () => {
        const { registry, flags, calls } = fakes();
        flags.set('no_conflict', false);
        const rt = createRuntime(gateDef, { registry });
        const r = runner(rt);
        r.step(); // 进入 gate
        const result = rt.step(r.state(), nextSeed());
        expect(result.status).toBe('stuck');
        if (result.status !== 'stuck') throw new Error('unreachable');
        expect(result.reason).toContain('when');
        expect(r.state().position).toBe('gate'); // 边上写着「此刻不走」，就不能因为「只有这一条」而硬走
        expect(calls).toEqual(['check_green@gate', 'no_conflict@gate']); // 边的条件真的被求值了
    });

    it('`when` 是**边的条件**：actor 宣布走同一条边时同样算数（不满足 → edge-unavailable）', () => {
        const { registry, flags } = fakes();
        flags.set('no_conflict', false);
        const wf = defineWorkflow({
            id: 'when-declare',
            entry: 'gate',
            nodes: [
                { id: 'gate', name: '闸门', actor: 'agent', guard: ['prompt:gate_ok'], hint: '' },
                { id: 'down', name: '下游', actor: 'system', guard: [], hint: '' },
            ],
            edges: [{ from: 'gate', to: 'down', kind: 'next', when: 'pred:no_conflict' }],
        });
        const rt = createRuntime(wf, { registry });
        const r = runner(rt);
        r.step(); // 进入 gate（`prompt:` 节点 → 等 actor）
        const e = caught(() => r.declare({ author: 'agent-1', to: 'down', content: '我宣布推进' }));
        expect(e.code).toBe('edge-unavailable');
        expect(e.path).toBe('edges[0].when');
        expect(r.state().position).toBe('gate'); // 位置没动：同一条边换个方向推，答案得一样
        flags.set('no_conflict', true);
        expect(r.declare({ author: 'agent-1', to: 'down', content: '条件成立了' }).state.position).toBe('down');
    });
});

describe('R7 死循环护栏：打回上限', () => {
    it('达到上限前放行，超出即 bounce-limit', () => {
        const { registry } = fakes();
        const rt = createRuntime(loopDef, { registry, maxBounces: 1 });
        const r = runner(rt);
        r.step(); // work
        r.declare({ author: '开发 agent', to: 'check', content: '做完了' });
        const first = r.declare({ author: '检查 agent', to: 'work', content: '不合格，打回' }); // 第 1 次打回
        expect(first.state.path.filter((v) => v.kind === 'bounce').length).toBe(1);

        r.declare({ author: '开发 agent', to: 'check', content: '改完了' });
        const e = caught(() => r.declare({ author: '检查 agent', to: 'work', content: '还是不合格' }));
        expect(e.code).toBe('bounce-limit');
        expect(e.message).toContain('上限 1');
        expect(r.state().position).toBe('check'); // 抛错不改状态
    });
});

describe('R8 端到端（##166 §14.3 的两条真实轨迹）', () => {
    it('开发：8 步含 1 次 actor 打回 —— prompt 节点由 actor 宣布、system 节点由系统自推', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry, maxBounces: 3 });
        const r = runner(rt);

        r.step(); // 进入入口 clarify（author = system）
        r.declare({ author: 'human', to: 'design', content: '需求无歧义，交设计' });
        r.declare({ author: '设计 agent', to: 'implement', content: '方案与边界已定' });
        r.declare({ author: '开发 agent', to: 'review', content: '开发完成，提交 Review' });
        r.declare({ author: 'Review agent', to: 'implement', content: 'P0：取消竞态未处理 → 打回' }); // ⟲
        r.declare({ author: '开发 agent', to: 'review', content: 'P0 已修，请复审' });
        r.declare({ author: 'Review agent', to: 'ci', content: '全部有落点，放行 CI' });
        r.step(); // ci：系统求值通过 → merge

        expect(rt.step(r.state(), nextSeed()).status).toBe('done'); // merge 是终态

        const projection = project(r.events, devDef);
        expect(projection.path.map((visit) => visit.node)).toEqual([
            'clarify',
            'design',
            'implement',
            'review',
            'implement',
            'review',
            'ci',
            'merge',
        ]);
        expect(projection.visits.implement).toBe(2); // 打回后第 2 次驻留，节点数不变
        expect(projection.path.filter((visit) => visit.kind === 'bounce').length).toBe(1);
        expect(projection.currentNode).toBe('merge');

        // 事件形状：可观测节点落 author = system，不可观测节点落宣布者
        expect(r.events.map((event) => event.author)).toEqual([
            'system',
            'human',
            '设计 agent',
            '开发 agent',
            'Review agent',
            '开发 agent',
            'Review agent',
            'system',
        ]);
        // 打回本身也是一条 Event，锚在目标节点上（##166 §10.3：转移就是一条发言）
        expect(r.events[4].anchor).toEqual({ type: 'node', data: { nodeId: 'implement' } });
    });

    it('金融：10 步含 1 次系统打回（风控不合格 → 引擎自己回退到筛选）', () => {
        const { registry, flags } = fakes();
        const rt = createRuntime(quantDef, { registry, maxBounces: 3 });
        const r = runner(rt);

        r.step(); // 进入入口 fetch
        r.step(); // fetch → factor
        r.step(); // factor → select
        r.declare({ author: '筛选 agent', to: 'backtest', content: '因子解读完成，交回测' });
        r.step(); // backtest → risk

        flags.set('weight_ok', false); // 单票 18% > 10%
        r.step(); // risk：不合格 → 系统打回 select ⟲
        r.declare({ author: '筛选 agent', to: 'backtest', content: '按风控约束重筛' });
        r.step(); // backtest → risk
        flags.set('weight_ok', true);
        r.step(); // risk → signoff
        r.declare({ author: 'human', to: 'order', content: '真金白银，签字' });

        // order 是终态节点：guard（`action:place_order`）过了也没有 next 出边 → done
        expect(rt.step(r.state(), nextSeed()).status).toBe('done');

        const projection = project(r.events, quantDef);
        expect(projection.path.map((visit) => visit.node)).toEqual([
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
        ]);
        expect(projection.path.filter((visit) => visit.kind === 'bounce').length).toBe(1);
        expect(projection.visits.select).toBe(2);
        expect(projection.visits.risk).toBe(2);
        expect(projection.currentNode).toBe('order');
    });
});

describe('R9 上下文与旁路：params 透传 / notify 唤醒 / status 分类', () => {
    it('ctx.params 原样交给插件（L2 实例参数由 ##316 注入，本层只透传）', () => {
        const seen: unknown[] = [];
        const registry = createRegistry().register('guard', 'echo', (ctx) => {
            seen.push({ params: ctx.params, node: ctx.node.id, actor: ctx.actor });
            return { pass: true };
        });
        const def = defineWorkflow({ nodes: [{ id: 'solo', name: '单节点', actor: 'system', guard: ['pred:echo'], hint: '' }], edges: [] });
        const rt = createRuntime(def, { registry, params: { ci: { command: 'npm test' }, review: { maxBounces: 3 } } });
        const r = runner(rt);
        r.step(); // 进入入口 solo（进入本身不判 guard）
        expect(rt.step(r.state(), nextSeed()).status).toBe('done'); // 判 guard（echo 被调用）→ 无出边

        expect(seen).toEqual([{ params: { ci: { command: 'npm test' }, review: { maxBounces: 3 } }, node: 'solo', actor: 'system' }]);
    });

    it('每次转移后唤醒 notify 插件，回执随结果返回', () => {
        const { registry } = fakes();
        const rt = createRuntime(pairDef, { registry, notify: ['wake'] });
        const r = runner(rt);
        const entered = r.step();
        expect(entered.receipts).toEqual([{ delivered: ['system'], note: auditOf(entered).id }]);
        const moved = r.step();
        expect(moved.receipts).toEqual([{ delivered: ['system'], note: auditOf(moved).id }]);
    });

    it('status：现在轮到谁（entry / system / actor）与已有打回数', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        expect(rt.status(initialState<IdOf<typeof devDef>>()).mode).toBe('entry');

        const r = runner(rt);
        r.step(); // clarify（human 的 prompt 节点）
        const atClarify = rt.status(r.state());
        expect(atClarify.mode).toBe('actor');
        expect(atClarify.pending.map((ref) => ref.raw)).toEqual(['prompt:clear_enough']);
        expect(atClarify.position).toBe('clarify');
        expect(atClarify.bounces).toBe(0);

        r.declare({ author: 'human', to: 'design', content: '交设计' });
        r.declare({ author: '设计 agent', to: 'implement', content: '交开发' });
        r.declare({ author: '开发 agent', to: 'review', content: '交 Review' });
        r.declare({ author: 'Review agent', to: 'implement', content: '打回' });
        const atImplement = rt.status(r.state());
        expect(atImplement.mode).toBe('actor');
        expect(atImplement.bounces).toBe(1);
        expect(atImplement.outEdges.map((edge) => edge.to)).toEqual(['review']);
    });

    it('guard 引用形状：`prompt:` / `pred:` / `action:` + 名字', () => {
        expect(parseGuardRef('pred:ci_green')).toEqual({ raw: 'pred:ci_green', prefix: 'pred', name: 'ci_green' });
        expect(classifyGuards(['pred:a', 'prompt:b']).mode).toBe('actor');
        expect(classifyGuards([]).mode).toBe('system');
        expect(caught(() => parseGuardRef('ci_green')).code).toBe('invalid-guard'); // 缺前缀
        expect(caught(() => parseGuardRef('perd:x')).code).toBe('invalid-guard'); // 未知前缀
        expect(caught(() => parseGuardRef('pred:')).code).toBe('invalid-guard'); // 缺名字
    });

    it('没进入工作流就宣布转移 → invalid-entry（位置为空的唯一合法入口是 step）', () => {
        const { registry } = fakes();
        const rt = createRuntime(pairDef, { registry });
        const e = caught(() => rt.declare(initialState<IdOf<typeof pairDef>>(), { ...nextSeed(), author: 'agent', to: 'b', content: '' }));
        expect(e.code).toBe('invalid-entry');
    });

    it('未知选项 / 拼错护栏名 → invalid-option（形状封闭，绝不静默忽略）', () => {
        const { registry } = fakes();
        // @ts-expect-error 故意把 maxBounces 拼成 maxBounce
        const e = caught(() => createRuntime(pairDef, { registry, maxBounce: 1 }));
        expect(e.code).toBe('invalid-option');
        expect(e.path).toBe('options.maxBounce');
        // step 的 seed 也只认 { id, at }
        const rt = createRuntime(pairDef, { registry });
        // @ts-expect-error 故意多带一个字段
        expect(caught(() => rt.step(initialState<IdOf<typeof pairDef>>(), { id: 'e', at: AT, 多余: 1 })).code).toBe('invalid-option');
        const r = runner(rt);
        r.step();
        // @ts-expect-error 宣布请求只认 { id, at, author, to, content, causes? } —— 形状错与 author 非法同一个码
        expect(caught(() => rt.declare(r.state(), { ...nextSeed(), author: 'agent', to: 'b', content: 'x', 多余: 1 })).code).toBe('invalid-declare');
    });

    it('notify 失败不作废转移：事实（state + event）照样落定，失败只记账', () => {
        const registry = createRegistry()
            .register('guard', 'check_green', () => ({ pass: true }))
            .register('guard', 'intent_green', () => ({ pass: true }))
            .register('notify', 'boom', () => {
                throw new Error('通知服务挂了');
            });
        const rt = createRuntime(pairDef, { registry, notify: ['boom'] });
        const r = runner(rt);
        const entered = r.step(); // 不抛
        expect(entered.state.position).toBe('a');
        expect(auditOf(entered).author).toBe('system');
        expect(entered.receipts).toEqual([]);
        expect(entered.notifyErrors.map((failure) => failure.plugin)).toEqual(['boom']);
        expect(entered.notifyErrors[0].error.code).toBe('plugin-threw');
        expect(entered.notifyErrors[0].error.message).toContain('通知服务挂了');
    });

    it('插件自己抛原生 Error → 统一包成 FlowError（code = plugin-threw），不让它直穿内核', () => {
        const registry = createRegistry().register('guard', 'explode', () => {
            throw new Error('CI 服务 500');
        });
        const def = defineWorkflow({ nodes: [{ id: 'solo', name: '单', actor: 'system', guard: ['pred:explode'], hint: '' }], edges: [] });
        const rt = createRuntime(def, { registry });
        const r = runner(rt);
        r.step(); // 进入 solo
        const e = caught(() => rt.step(r.state(), nextSeed()));
        expect(e.code).toBe('plugin-threw');
        expect(e.path).toBe('guard[0]');
        expect(e.message).toContain('CI 服务 500');
    });

    it('ctx.params 是冻结的副本：插件改不动宿主对象', () => {
        const registry = createRegistry().register('guard', 'probe', () => ({ pass: true }));
        const def = defineWorkflow({ nodes: [{ id: 'solo', name: '单', actor: 'system', guard: ['pred:probe'], hint: '' }], edges: [] });
        const host = { ci: { command: 'npm test' } };
        const rt = createRuntime(def, { registry, params: host });
        expect(rt.params).toEqual(host);
        expect(rt.params).not.toBe(host); // 不是宿主那个对象
        expect(Object.isFrozen(rt.params)).toBe(true);
    });

    it('宣布一条不存在的边 → no-edge（不许跳步）', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const r = runner(rt);
        r.step(); // clarify
        const e = caught(() => r.declare({ author: 'human', to: 'review', content: '跳过设计' }));
        expect(e.code).toBe('no-edge');
    });
});

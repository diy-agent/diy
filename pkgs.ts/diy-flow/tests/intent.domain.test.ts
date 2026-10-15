// tests/intent.domain.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「领域状态一等」意图测试（##333）—— 需求级（人类语言描述需求，不描述实现）
//
// 判据（用户 2026-10-15 拍板）：**领域状态（`path` / `position` / params 值）是一等真源、可独立
// 落盘；`Event` 从 core 退出 —— 进程内只是「进度通知消息」，落盘后只是审计/统计材料。**
// 一句话判据：**「第 n 次驻留」是领域事实（进 `path`）；「这条 Event」是消息（审计）。**
//
//   R1  领域态自足：`advance` / `step` 不吃日志也能推进；领域态里**不含任何日志 id**
//   R2  落盘 / 读回可信：`flowStateToJson` / `parseFlowState` / `flowStateFromJson` 往返恒等，
//       非法快照（形状 / 语义自相矛盾）一律抛 `FlowError`
//   R3  审计入口是**薄适配**：`apply`（Event → 领域推进）与 `advance` 等价，报错码与旧版逐条一致；
//       `project` 仍能从日志重建折线（但重建不出运行期发现的终态标记）
//   R4  内核**不编人类文本**：转移给结构化语义 `move = { kind, from, to }` + `reason`；正文由宿主给
//   R5  关联靠**显式 ref**（`taskUri` / `turnId` / `stepId`）：内核只透传不解释
//   R6  终态记账：跑完是**领域事实**（`FlowState.done`）—— 重复 `step` 不重跑 `action:`；
//       终态判据是**结构事实**（没有 `next` 出边），边上的 `when` **不参与**判定（有边而 `when` 不过 = `stuck`）
//   R7  **`params` 值纳入状态**（##311 §二 L3 / ##333 交付 G）：L2 实例值随领域态流转、落盘、读回 ——
//       「状态文件为一等真源」读回后跑得回原样；值语义仍归 ##316 `resolveParams`（本包不重写校验）。
//       两条不变量：① 已进入却没记参数值 = 丢了配置 ⇒ 亮错（「缺省」与「丢了」分开）；② 凡从 runtime
//       出来的 state 一律带本次运行的参数值（`done` 分支也不例外）。冻结深度差异见 `rule.param-bag-when-undeclared`
//
// 测试风格：与 `intent.flow.test.ts` / `intent.plugin.test.ts` 同形（`caught()` / 真实工作流素材），
// 断言公开 API 的行为与错误码，不断言内部实现。
// ═══════════════════════════════════════════════════════════════

import { createEvent, type Event } from '@diy/talk';
import { describe, expect, it } from 'vitest';
import {
    FlowError,
    advance,
    apply,
    createContainer,
    createRegistry,
    createRuntime,
    defineWorkflow,
    flowStateFromJson,
    flowStateToJson,
    initialState,
    isFlowState,
    parseFlowState,
    project,
    type FlowState,
    type PluginContext,
    type WorkflowDef,
} from '../src/index';

/** 从 `defineWorkflow` 的产物取出节点 id 的字面量联合（同 intent.plugin.test.ts） */
type IdOf<W> = W extends WorkflowDef<infer Id> ? Id : never;

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

const AT = '2026-10-13T00:00:00.000Z';
const AT2 = '2026-10-13T00:00:01.000Z';
const AT3 = '2026-10-13T00:00:02.000Z';

/** 素材：开发工作流（##166 §14.3）—— 入口 clarify → design → implement → review（可打回 implement）→ ci */
const devDef = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    nodes: [
        { id: 'clarify', name: '需求澄清', actor: 'agent', guard: ['prompt:clear_enough'], hint: '问清需求' },
        { id: 'design', name: '设计', actor: 'agent', guard: ['prompt:design_done'], hint: '出方案' },
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '写码' },
        { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '审' },
        { id: 'ci', name: 'CI', actor: 'system', guard: ['pred:check_green'], hint: '流水线' },
    ],
    edges: [
        { from: 'clarify', to: 'design', kind: 'next' },
        { from: 'design', to: 'implement', kind: 'next' },
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
    ],
});

/** 素材：系统工作流（guard 全可观测，系统自己推；终态 `end` 没有出边） */
const sysDef = defineWorkflow({
    id: 'sys',
    name: '流水线',
    nodes: [
        { id: 'build', name: '构建', actor: 'system', guard: ['pred:build_ok'], hint: '编译' },
        { id: 'end', name: '收尾', actor: 'system', guard: [], hint: '收尾' },
    ],
    edges: [{ from: 'build', to: 'end', kind: 'next' }],
});

/** 素材：带参数声明的系统工作流（##316：`ci.command` 声明在节点上，值走数据） */
const ciDef = defineWorkflow({
    id: 'ci',
    name: 'CI',
    nodes: [
        {
            id: 'ci',
            name: 'CI',
            actor: 'system',
            guard: ['pred:check_green'],
            hint: '跑 ${command}',
            params: [{ name: 'command', type: 'string', label: 'CI 命令', default: 'npm test' }],
        },
        { id: 'merge', name: '合并', actor: 'system', guard: [], hint: '' },
    ],
    edges: [{ from: 'ci', to: 'merge', kind: 'next' }],
});

function move(to: string, opts: { id?: string; at?: string } = {}): Event {
    return createEvent({
        id: opts.id ?? `e-${to}-${opts.at ?? AT}`,
        author: 'agent',
        anchor: { type: 'node', data: { nodeId: to } },
        content: `→ ${to}`,
        at: opts.at ?? AT,
    });
}

/** 一串「折线」：clarify → design → implement → review → implement（打回） */
function walked(): { state: FlowState<string>; events: Event[] } {
    const events = [move('clarify', { id: 'EVT-A' }), move('design', { id: 'EVT-B' }), move('implement', { id: 'EVT-C' }), move('review', { id: 'EVT-D' }), move('implement', { id: 'EVT-E', at: AT2 })];
    let state = initialState<IdOf<typeof devDef>>();
    for (const event of events) state = apply(devDef, state, event);
    return { state, events };
}

/** 假插件：只记账（`calls` 断言「谁被求值了 / 谁没被执行」） */
function fakes(): { registry: ReturnType<typeof createRegistry>; calls: string[] } {
    const calls: string[] = [];
    const registry = createRegistry();
    registry.register('guard', 'build_ok', (ctx: PluginContext) => {
        calls.push(`build_ok@${ctx.node.id}`);
        return { pass: true };
    });
    registry.register('guard', 'check_green', (ctx: PluginContext) => {
        calls.push(`check_green@${ctx.node.id}`);
        return { pass: true };
    });
    return { registry, calls };
}

// ─────────────────────────────────────────────────────────────
describe('R1 领域态自足：不吃日志也能推进，且态里不含日志 id', () => {
    it('advance 只吃领域输入（to / at），产出的态里**没有**事件 id 字段', () => {
        const first = advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'clarify', at: AT });
        expect(first.kind).toBe('next');
        expect(first.state.position).toBe('clarify');
        expect(first.state.path).toEqual([{ node: 'clarify', seq: 1, kind: 'next', at: AT }]);

        const second = advance(devDef, first.state, { to: 'design', at: AT2 });
        expect(second.state.path[1]).toEqual({ node: 'design', seq: 1, kind: 'next', at: AT2 });
    });

    it('`step` 不给 `id` = 纯领域推进：`transition.event === undefined`，领域态照样前进', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof devDef>>(), { at: AT });
        expect(entered.status).toBe('moved');
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.event).toBeUndefined();
        expect(entered.transition.state.position).toBe('clarify');
        expect(entered.transition.receipts).toEqual([]); // 无事件 = 无通知（notify 是审计侧的事）
    });

    it('领域态里**不含**任何日志 id —— 拿一串显眼的事件 id 走一遍，落盘文本里一个都不出现', () => {
        const { state } = walked();
        const json = flowStateToJson(state);
        for (const marker of ['EVT-A', 'EVT-B', 'EVT-C', 'EVT-D', 'EVT-E']) {
            expect(json).not.toContain(marker);
        }
        expect(Object.keys(state.path[0])).toEqual(['node', 'seq', 'kind', 'at']);
    });

    it('「第 n 次驻留」是领域事实：打回后重返 = 同一节点 `seq` 递增（不是一条边）', () => {
        const { state } = walked();
        expect(state.path.map((visit) => `${visit.node}#${visit.seq}:${visit.kind}`)).toEqual([
            'clarify#1:next',
            'design#1:next',
            'implement#1:next',
            'review#1:next',
            'implement#2:bounce',
        ]);
    });

    it('非法推进照旧大声报（码与旧版一致）：未知节点 / 未进入却没进入口 / 没有边', () => {
        expect(caught(() => advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'nope', at: AT })).code).toBe('unknown-node');
        expect(caught(() => advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'design', at: AT })).code).toBe('invalid-entry');
        const { state } = walked();
        expect(caught(() => advance(devDef, state, { to: 'clarify', at: AT3 })).code).toBe('no-edge');
    });

    it('`at` 是领域事实：非 ISO-8601 一律拒（落盘的东西必须先是事实）', () => {
        const e = caught(() => advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'clarify', at: '昨天下午' }));
        expect(e.code).toBe('invalid-option');
        expect(e.path).toBe('request.at');
    });
});

// ─────────────────────────────────────────────────────────────
describe('R2 落盘 / 读回可信（serialize）', () => {
    it('往返恒等：有 `path`、无事件的状态也能落盘并读回（验收项）', () => {
        const first = advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'clarify', at: AT });
        const second = advance(devDef, first.state, { to: 'design', at: AT2 });
        const json = flowStateToJson(second.state);
        expect(flowStateFromJson(json)).toEqual(second.state);
        expect(JSON.parse(json)).toEqual({ position: 'design', path: second.state.path });
    });

    it('终态标记也在快照里（`done` 是领域事实，不是日志事实）', () => {
        const { registry } = fakes();
        const rt = createRuntime(sysDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof sysDef>>(), { at: AT });
        if (entered.status !== 'moved') throw new Error('unreachable');
        const moved = rt.step(entered.transition.state, { at: AT2 });
        if (moved.status !== 'moved') throw new Error('unreachable');
        const done = rt.step(moved.transition.state, { at: AT3 });
        if (done.status !== 'done') throw new Error('unreachable');
        const json = flowStateToJson(done.state);
        expect(JSON.parse(json).done).toBe(true);
        expect(flowStateFromJson(json).done).toBe(true);
    });

    it('紧凑单行（jsonl 用）：`{ compact: true }` 输出一行', () => {
        const { state } = walked();
        const compact = flowStateToJson(state, { compact: true });
        expect(compact.includes('\n')).toBe(false);
        expect(flowStateFromJson(compact)).toEqual(state);
    });

    it('形状错一律抛 `invalid-state`：未知字段 / 缺 position / 坏 `at` / `done` 非 boolean', () => {
        const { state } = walked();
        expect(caught(() => parseFlowState({ ...state, 多余: 1 })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ path: state.path })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: 'design', path: [{ ...state.path[0], at: 'now' }] })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ ...state, done: 'yes' })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: 'design', path: [{ ...state.path[0], kind: 'sideways' }] })).code).toBe('invalid-state');
    });

    it('**语义自相矛盾**的状态也拦下：位置与折线末端不一致 / 位置空却有折线 / `seq` 不单调', () => {
        const { state } = walked();
        const last = state.path[state.path.length - 1];
        expect(caught(() => parseFlowState({ position: 'design', path: state.path })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: null, path: state.path })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: 'design', path: [{ ...last, seq: 3 }] })).code).toBe('invalid-state');
        expect(parseFlowState({ position: null, path: [] })).toEqual({ position: null, path: [] }); // 空态是合法的
    });

    it('非法 JSON 抛 `invalid-json`；`isFlowState` 是非抛出版试探', () => {
        expect(caught(() => flowStateFromJson('{ 不是 json')).code).toBe('invalid-json');
        expect(isFlowState({ position: null, path: [] })).toBe(true);
        expect(isFlowState({ position: 'x', path: [] })).toBe(false);
    });

    it('`allowUnknown` 只放行、不保留（同 @diy/talk 的口径）', () => {
        const { state } = walked();
        const withExtra = { ...state, 新版本字段: 1 };
        expect(caught(() => parseFlowState(withExtra)).code).toBe('invalid-state');
        expect(parseFlowState(withExtra, 'flowState', { allowUnknown: true })).toEqual(state);
    });

    it('`at` **不要求单调**（立场）：折线次序由 `path` 承载 —— `at` 倒流照收，读盘的人别拿 `at` 排序', () => {
        // 第二次驻留的 `at` 比第一次**早**（时钟回拨 / 宿主补录）：次序看数组下标，不看 `at`
        const reversed = parseFlowState<IdOf<typeof devDef>>({
            position: 'design',
            path: [
                { node: 'clarify', seq: 1, kind: 'next', at: AT3 },
                { node: 'design', seq: 1, kind: 'next', at: AT },
            ],
        });
        expect(reversed.path.map((v) => v.node)).toEqual(['clarify', 'design']);
        expect(reversed.path.map((v) => v.at)).toEqual([AT3, AT]);
        expect(flowStateFromJson(flowStateToJson(reversed))).toEqual(reversed); // 倒流的 `at` 原样落盘 / 读回
    });

    it('写侧同样严格：拿一个「形状像但字段非法」的对象去序列化，当场报错（不静默抹掉）', () => {
        const { state } = walked();
        expect(caught(() => flowStateToJson({ ...state, path: [{ ...state.path[0], seq: 0 }] })).code).toBe('invalid-state');
    });

    it('语义自洽：`done === true` 却从未进入工作流 ⇒ `invalid-state`（「跑完」的前提是先进入）', () => {
        expect(caught(() => parseFlowState({ position: null, path: [], done: true })).code).toBe('invalid-state');
        expect(parseFlowState({ position: null, path: [], done: false })).toEqual({ position: null, path: [], done: false });
    });

    it('立场：`params` 只兜**纯 JSON 性**、不兜**值语义** —— 脏值读得进来，但进不了运行态', () => {
        const dirty = { position: null, path: [], params: { ci: { command: 1 } } };
        expect(parseFlowState(dirty)).toEqual(dirty); // 读侧只保证「写下去能读回来」
        const { registry } = fakes();
        const e = caught(() => createRuntime(ciDef, { registry, params: dirty.params })); // 闸门仍只在 ##316
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('values.ci.command');
    });
});

// ─────────────────────────────────────────────────────────────
describe('R3 审计入口是薄适配：`apply` / `project` 语义不变', () => {
    it('`apply(event)` ≡ `advance({ to, at })`：同一条日志走出来的态与领域正路一模一样', () => {
        const { state, events } = walked();
        let replayed: FlowState<string> = initialState<string>();
        for (const event of events) replayed = advance<string>(devDef, replayed, { to: event.anchor.type === 'node' ? event.anchor.data.nodeId : '', at: event.at }).state;
        expect(replayed).toEqual(state);
    });

    it('报错码与定位路径与旧版逐条一致（锚点类型 / 未知节点 / 未进入口 / 没有边）', () => {
        const notNode = createEvent({ id: 'x1', author: 'a', anchor: { type: 'task-field', data: { field: 'title' } }, content: '', at: AT });
        expect(caught(() => apply(devDef, initialState<IdOf<typeof devDef>>(), notNode)).code).toBe('invalid-event');
        const unknown = caught(() => apply(devDef, initialState<IdOf<typeof devDef>>(), move('nope')));
        expect(unknown.code).toBe('unknown-node');
        expect(unknown.path).toBe('event.anchor.data.nodeId');
        const badEntry = caught(() => apply(devDef, initialState<IdOf<typeof devDef>>(), move('design')));
        expect(badEntry.code).toBe('invalid-entry');
        const { state } = walked();
        expect(caught(() => apply(devDef, state, move('clarify'))).code).toBe('no-edge');
    });

    it('`project` 仍能从日志重建折线（审计侧的重建路径）；重建不出运行期发现的 `done`', () => {
        const { events } = walked();
        const projection = project(events, devDef);
        expect(projection.currentNode).toBe('implement');
        expect(projection.visits).toEqual({ clarify: 1, design: 1, implement: 2, review: 1 });
        expect(projection.path.map((visit) => visit.seq)).toEqual([1, 1, 1, 1, 2]);
    });
});

// ─────────────────────────────────────────────────────────────
describe('R4 内核不编人类文本：转移给结构化语义', () => {
    it('`move` 三态：entry / next / bounce（含 from / to），`reason` 带 guard 的原因', () => {
        const calls: string[] = [];
        const registry = createRegistry()
            .register('guard', 'check_green', () => ({ pass: true }))
            .register('guard', 'dev_done', () => {
                calls.push('dev_done');
                return { pass: false, reason: '开发没做完' };
            })
            .register('guard', 'review_done', () => ({ pass: true }));
        const rt = createRuntime(devDef, { registry });

        const entered = rt.step(initialState<IdOf<typeof devDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.move).toEqual({ kind: 'entry', from: null, to: 'clarify' });

        const declared = rt.declare(entered.transition.state, { id: 'e2', at: AT2, author: 'human', to: 'design', content: '需求清楚了' });
        expect(declared.move).toEqual({ kind: 'next', from: 'clarify', to: 'design' });
        expect(declared.reason).toBe('');
    });

    it('系统打回：`move.kind = bounce` + `reason` 带失败原因（正文由宿主渲染）', () => {
        const bounceDef = defineWorkflow({
            id: 'bounce',
            name: '打回',
            entry: 'start',
            nodes: [
                { id: 'start', name: '起', actor: 'agent', guard: [], hint: '' },
                { id: 'check', name: '检查', actor: 'system', guard: ['pred:check_green'], hint: '' },
            ],
            edges: [
                { from: 'start', to: 'check', kind: 'next' },
                { from: 'check', to: 'start', kind: 'bounce' },
            ],
        });
        const registry = createRegistry().register('guard', 'check_green', () => ({ pass: false, reason: 'CI 红' }));
        const rt = createRuntime(bounceDef, { registry });
        let state = initialState<IdOf<typeof bounceDef>>();
        for (const [i, at] of [AT, AT2].entries()) {
            const result = rt.step(state, { at, id: `e${i}` });
            if (result.status !== 'moved') throw new Error(`期望 moved，实得 ${result.status}`);
            state = result.transition.state;
        }
        const bounced = rt.step(state, { at: AT3, id: 'e-bounce' });
        if (bounced.status !== 'moved') throw new Error(`期望 moved，实得 ${bounced.status}`);
        expect(bounced.transition.move).toEqual({ kind: 'bounce', from: 'check', to: 'start' });
        expect(bounced.transition.reason).toContain('CI 红');
        expect(bounced.transition.state.path[2]).toEqual({ node: 'start', seq: 2, kind: 'bounce', at: AT3 });
    });

    it('审计事件的正文由宿主给（不给 = 空串）：内核一个人类字都不编', () => {
        const { registry } = fakes();
        const rt = createRuntime(sysDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof sysDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.event?.content).toBe('');

        const withText = rt.step(initialState<IdOf<typeof sysDef>>(), { at: AT, id: 'e2', content: '宿主渲染的正文' });
        if (withText.status !== 'moved') throw new Error('unreachable');
        expect(withText.transition.event?.content).toBe('宿主渲染的正文');
    });
});

// ─────────────────────────────────────────────────────────────
describe('R5 关联靠显式 ref（内核只透传不解释）', () => {
    it('`step` 的 `seed.ref` 落到 `Visit.ref`；`advance` 的 `ref` 同样', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof devDef>>(), { at: AT, id: 'e1', ref: { taskUri: 'projects/4/tasks/333', turnId: 't7' } });
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.state.path[0].ref).toEqual({ taskUri: 'projects/4/tasks/333', turnId: 't7' });

        const direct = advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'clarify', at: AT, ref: { stepId: 's1' } });
        expect(direct.state.path[0].ref).toEqual({ stepId: 's1' });
    });

    it('ref 是**开放袋**（键不封闭）但值必须是字符串：值错了大声报', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const bad = caught(() => rt.step(initialState<IdOf<typeof devDef>>(), { at: AT, ref: { turnId: 7 } as unknown as Record<string, string> }));
        expect(bad.code).toBe('invalid-option');
        expect(bad.path).toBe('seed.ref.turnId');
    });

    it('ref 随状态一起落盘读回（关联是领域记录的一部分，不是日志的一部分）', () => {
        const state = advance(devDef, initialState<IdOf<typeof devDef>>(), { to: 'clarify', at: AT, ref: { taskUri: 'projects/4/tasks/333' } }).state;
        expect(flowStateFromJson(flowStateToJson(state))).toEqual(state);
    });

    it('审计侧要指回领域：用折线末端的 `{ node, seq }` 作坐标（方向反转）', () => {
        const { registry } = fakes();
        const rt = createRuntime(devDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof devDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        const last = entered.transition.state.path[entered.transition.state.path.length - 1];
        expect({ node: last.node, seq: last.seq }).toEqual({ node: entered.transition.move.to, seq: 1 });
    });
});

// ─────────────────────────────────────────────────────────────
describe('R6 终态记账：跑完是领域事实，重复 `step` 不重跑 `action:`', () => {
    it('终态：`status = done` + `state.done = true`（不是异常，也不是「卡住」）', () => {
        const { registry } = fakes();
        const rt = createRuntime(sysDef, { registry });
        const entered = rt.step(initialState<IdOf<typeof sysDef>>(), { at: AT });
        if (entered.status !== 'moved') throw new Error('unreachable');
        const moved = rt.step(entered.transition.state, { at: AT2 });
        if (moved.status !== 'moved') throw new Error('unreachable');
        const done = rt.step(moved.transition.state, { at: AT3 });
        expect(done.status).toBe('done');
        if (done.status !== 'done') throw new Error('unreachable');
        expect(done.state.done).toBe(true);
        expect(rt.status(done.state).done).toBe(true);
    });

    it('重复 `step` 一个插件都不调（`action:` 不会因为「终态再推一次」而重跑）', () => {
        const calls: string[] = [];
        const registry = createRegistry()
            .register('guard', 'build_ok', () => ({ pass: true }))
            .register('action', 'ship', () => {
                calls.push('action:ship');
                return { ok: true };
            });
        const shipping = defineWorkflow({
            id: 'ship',
            name: '发布',
            nodes: [
                { id: 'build', name: '构建', actor: 'system', guard: ['pred:build_ok', 'action:ship'], hint: '构建并发布' },
                { id: 'end', name: '收尾', actor: 'system', guard: [], hint: '收尾' },
            ],
            edges: [{ from: 'build', to: 'end', kind: 'next' }],
        });
        const rt = createRuntime(shipping, { registry });
        let state = initialState<IdOf<typeof shipping>>();
        for (const [i, at] of [AT, AT2].entries()) {
            const result = rt.step(state, { at, id: `e${i}` });
            if (result.status !== 'moved') throw new Error(`期望 moved，实得 ${result.status}`);
            state = result.transition.state;
        }
        expect(calls).toEqual(['action:ship']); // 只在离开 build 那一步求值过一次

        const again = rt.step(state, { at: AT3, id: 'e9' });
        expect(again.status).toBe('done');
        expect(calls).toEqual(['action:ship']); // **没有第二次**
    });

    it('终态标记能落盘读回：盘上那份状态不会因为重启而重跑一次 `action:`', () => {
        const { registry } = fakes();
        const rt = createRuntime(sysDef, { registry });
        let state = initialState<IdOf<typeof sysDef>>();
        for (const [i, at] of [AT, AT2, AT3].entries()) {
            const result = rt.step(state, { at, id: `e${i}` });
            if (result.status === 'moved') state = result.transition.state;
            else if (result.status === 'done') state = result.state;
        }
        const restored = flowStateFromJson<IdOf<typeof sysDef>>(flowStateToJson(state));
        expect(restored.done).toBe(true);
        expect(rt.step(restored, { at: AT }).status).toBe('done');
    });

    it('终态判据是**结构事实**（没有 `next` 出边），边上的 `when` 不参与：只有 `bounce` 出边的节点 guard 全过 = `done`', () => {
        const registry = createRegistry()
            .register('guard', 'ok', () => ({ pass: true }))
            .register('guard', 'gate', () => ({ pass: false }));
        const bounceOnly = defineWorkflow({
            id: 'bounce-only',
            name: '只有打回边',
            nodes: [
                { id: 'a', name: 'A', actor: 'system', guard: ['pred:ok'], hint: '' },
                { id: 'back', name: '退', actor: 'system', guard: [], hint: '' },
            ],
            edges: [{ from: 'a', to: 'back', kind: 'bounce' }],
        });
        const rt = createRuntime(bounceOnly, { registry });
        const entered = rt.step(initialState<IdOf<typeof bounceOnly>>(), { at: AT });
        if (entered.status !== 'moved') throw new Error('unreachable');
        // guard 全过、`bounce` 边不是「下一步」⇒ 没有下一步可走 = 跑完（不是「打回」）
        const done = rt.step(entered.transition.state, { at: AT2 });
        expect(done.status).toBe('done');
        if (done.status !== 'done') throw new Error('unreachable');
        expect(done.state.done).toBe(true);
    });

    it('有 `next` 出边、只是边上 `when` 不成立 → 停在**边上**（`stuck`），**不是** `done`', () => {
        const registry = createRegistry()
            .register('guard', 'ok', () => ({ pass: true }))
            .register('guard', 'gate', () => ({ pass: false }));
        const gated = defineWorkflow({
            id: 'gated',
            name: '带门边',
            nodes: [
                { id: 'a', name: 'A', actor: 'system', guard: ['pred:ok'], hint: '' },
                { id: 'b', name: 'B', actor: 'system', guard: [], hint: '' },
            ],
            edges: [{ from: 'a', to: 'b', kind: 'next', when: 'pred:gate' }],
        });
        const rt = createRuntime(gated, { registry });
        const entered = rt.step(initialState<IdOf<typeof gated>>(), { at: AT });
        if (entered.status !== 'moved') throw new Error('unreachable');
        const stuck = rt.step(entered.transition.state, { at: AT2 });
        expect(stuck.status).toBe('stuck'); // 结构上有下一步（边在），只是这一步走不了
        expect(entered.transition.state.done).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────
describe('R7 `params` 值纳入状态（状态文件为一等真源）', () => {
    /** 记录插件读到的参数值（证明「状态里那份」真的驱动了运行） */
    function spy(): { registry: ReturnType<typeof createRegistry>; seen: unknown[] } {
        const seen: unknown[] = [];
        const registry = createRegistry().register('guard', 'check_green', (ctx) => {
            seen.push((ctx.params as { ci?: { command?: string } }).ci?.command);
            return { pass: true };
        });
        return { registry, seen };
    }

    it('产出的领域态里带着这次运行用的 L2 实例值（全量、含合并后的缺省）', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        const entered = rt.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.state.params).toEqual({ ci: { command: 'pnpm test' } });

        const byDefault = createRuntime(ciDef, { registry });
        const entered2 = byDefault.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' });
        if (entered2.status !== 'moved') throw new Error('unreachable');
        expect(entered2.transition.state.params).toEqual({ ci: { command: 'npm test' } }); // 缺省已合并
    });

    it('参数值随状态落盘 / 读回：`flowStateToJson` 里有它，读回来一模一样', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        const entered = rt.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        const json = flowStateToJson(entered.transition.state);
        expect(JSON.parse(json).params).toEqual({ ci: { command: 'pnpm test' } });
        expect(flowStateFromJson(json)).toEqual(entered.transition.state);
    });

    it('**读回后跑得回原样**：把 `state.params` 交回 createRuntime，插件读到的还是那份值', () => {
        const { registry, seen } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        const entered = rt.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');

        // 「重启」：盘上那份状态是唯一凭据（registry 是新起的，参数值从状态里取）
        const restored = flowStateFromJson<IdOf<typeof ciDef>>(flowStateToJson(entered.transition.state));
        const restarted = createRuntime(ciDef, { registry, params: restored.params });
        const moved = restarted.step(restored, { at: AT2, id: 'e2' });
        expect(moved.status).toBe('moved');
        expect(seen).toEqual(['pnpm test']); // 不是缺省 'npm test' —— 状态文件说了算
    });

    it('状态带着另一份参数值 → 当场亮错（不静默按谁跑）：`invalid-param @ state.params`', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        const entered = rt.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');

        const other = createRuntime(ciDef, { registry }); // 缺省 'npm test'
        const e = caught(() => other.step(entered.transition.state, { at: AT2, id: 'e2' }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('state.params');
        expect(e.message).toContain('state.params');
    });

    it('键序不同不算「另一份参数」（读回后键序变了很正常）', () => {
        const { registry } = spy();
        const two = defineWorkflow({
            id: 'two',
            name: '两参数',
            nodes: [
                {
                    id: 'a',
                    name: 'A',
                    actor: 'system',
                    guard: [],
                    hint: '',
                    params: [
                        { name: 'x', type: 'string', label: 'X', default: '1' },
                        { name: 'y', type: 'string', label: 'Y', default: '2' },
                    ],
                },
            ],
            edges: [],
        });
        const rt = createRuntime(two, { registry, params: { a: { y: '2', x: '1' } } });
        const entered = rt.step(initialState<IdOf<typeof two>>(), { at: AT, id: 'e1' });
        expect(entered.status).toBe('moved');
    });

    it('快照里的参数值必须是纯 JSON：`NaN` / 函数 / 环形结构一律 `invalid-state`', () => {
        const cyclic: Record<string, unknown> = { a: {} };
        (cyclic.a as Record<string, unknown>).self = cyclic;
        expect(caught(() => parseFlowState({ position: null, path: [], params: { a: { n: Number.NaN } } })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: null, path: [], params: { a: { f: () => 1 } } })).code).toBe('invalid-state');
        expect(caught(() => parseFlowState({ position: null, path: [], params: cyclic })).code).toBe('invalid-state');
        expect(parseFlowState({ position: null, path: [], params: { a: { list: [1, 'x', true] } } })).toEqual({
            position: null,
            path: [],
            params: { a: { list: [1, 'x', true] } },
        });
    });

    it('未声明参数的工作流：宿主给的袋也随状态走；没给袋就不带 `params`（状态保持干净）', () => {
        const { registry } = fakes();
        const solo = defineWorkflow({ nodes: [{ id: 'solo', name: '单', actor: 'system', guard: [], hint: '' }], edges: [] });
        const bag = createRuntime(solo, { registry, params: { whatever: { deep: [1, 2] } } });
        const entered = bag.step(initialState<IdOf<typeof solo>>(), { at: AT, id: 'e1' });
        if (entered.status !== 'moved') throw new Error('unreachable');
        expect(entered.transition.state.params).toEqual({ whatever: { deep: [1, 2] } });

        const empty = createRuntime(solo, { registry });
        const entered2 = empty.step(initialState<IdOf<typeof solo>>(), { at: AT, id: 'e1' });
        if (entered2.status !== 'moved') throw new Error('unreachable');
        expect(entered2.transition.state.params).toBeUndefined();
        expect(Object.keys(entered2.transition.state)).toEqual(['position', 'path']);
    });

    it('值语义仍归 ##316（本包不重写校验）：非法实例值照旧在 `createRuntime` 就报', () => {
        const { registry } = spy();
        const e = caught(() => createRuntime(ciDef, { registry, params: { ci: { command: 42 } } }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('values.ci.command');
    });

    it('`advance` 继承参数值（换参数值不是一次「位置变更」，那是另起一次运行）', () => {
        const state = { ...initialState<IdOf<typeof ciDef>>(), params: { ci: { command: 'pnpm test' } } };
        const next = advance(ciDef, state, { to: 'ci', at: AT });
        expect(next.state.params).toEqual({ ci: { command: 'pnpm test' } });
        expect(next.state.done).toBeUndefined();
    });

    it('**已进入却没记参数值**的状态 → 当场亮错（不静默按本次这份跑）：`invalid-param @ state.params`', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        // 外来态：位置非空（已进入）却没记参数值 —— 它丢了自己的运行配置，不是「缺省」
        const stray: FlowState<IdOf<typeof ciDef>> = { position: 'ci', path: [{ node: 'ci', seq: 1, kind: 'next', at: AT }] };
        const e = caught(() => rt.step(stray, { at: AT2, id: 'e2' }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('state.params');
        expect(e.message).toContain('另起一次运行');
        // `declare` 同一条闸门
        expect(caught(() => rt.declare(stray, { author: 'agent', to: 'merge', content: '推', at: AT2, id: 'e3' })).code).toBe('invalid-param');
    });

    it('「缺省」与「丢了」分开：尚未进入（新一次运行）照旧跑；没声明参数的工作流没有配置可丢', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        expect(rt.step(initialState<IdOf<typeof ciDef>>(), { at: AT, id: 'e1' }).status).toBe('moved');

        const { registry: plain } = fakes();
        const solo = defineWorkflow({ nodes: [{ id: 'solo', name: '单', actor: 'system', guard: [], hint: '' }], edges: [] });
        const bare = createRuntime(solo, { registry: plain });
        const stray: FlowState<IdOf<typeof solo>> = { position: 'solo', path: [{ node: 'solo', seq: 1, kind: 'next', at: AT }] };
        expect(bare.step(stray, { at: AT2 }).status).toBe('done'); // 没声明参数 ⇒ 无配置可丢
    });

    it('终态产出态**也带**参数值（凡从 runtime 出来的 state 都带本次运行的配置）', () => {
        const { registry } = spy();
        const rt = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        let state = initialState<IdOf<typeof ciDef>>();
        let last = rt.step(state, { at: AT, id: 'e1' });
        for (const [i, at] of [AT2, AT3].entries()) {
            if (last.status !== 'moved') throw new Error(`期望 moved，实得 ${last.status}`);
            state = last.transition.state;
            last = rt.step(state, { at, id: `e${i + 2}` });
        }
        const done = last;
        expect(done.status).toBe('done');
        if (done.status !== 'done') throw new Error('unreachable');
        expect(done.state.params).toEqual({ ci: { command: 'pnpm test' } });
        // 终态落盘读回：盘上那份依旧自足（`done` 与 `params` 都在）
        expect(flowStateFromJson(flowStateToJson(done.state))).toEqual(done.state);
    });

    it('**【P1】`advance` 正路产出的就是完整真源**：走完 → 落盘 → 读回 → 喂回 `runtime.step` 照样跑得下去', () => {
        const { registry } = spy();
        // 宿主只用领域操作推进（连 runtime 都不建）—— 这条正路必须产出「读回后跑得回原样」的状态
        let state = advance(ciDef, initialState<IdOf<typeof ciDef>>(), { to: 'ci', at: AT, params: { ci: { command: 'pnpm test' } } }).state;
        state = advance(ciDef, state, { to: 'merge', at: AT2 }).state;
        expect(state.params).toEqual({ ci: { command: 'pnpm test' } });

        const restored = flowStateFromJson<IdOf<typeof ciDef>>(flowStateToJson(state));
        expect(restored).toEqual(state);
        const rt = createRuntime(ciDef, { registry, params: restored.params });
        expect(rt.step(restored, { at: AT3, id: 'e9' }).status).toBe('done'); // 不抛 invalid-param ⇒ 真源自足
    });

    it('`advance` 携带参数值：给了就用本次的、没给就继承入参那份；形状错照旧大声报', () => {
        const entered = advance(ciDef, initialState<IdOf<typeof ciDef>>(), { to: 'ci', at: AT, params: { ci: { command: 'pnpm test' } } }).state;
        expect(entered.params).toEqual({ ci: { command: 'pnpm test' } });
        expect(advance(ciDef, entered, { to: 'merge', at: AT2 }).state.params).toEqual({ ci: { command: 'pnpm test' } });

        const e = caught(() => advance(ciDef, initialState<IdOf<typeof ciDef>>(), { to: 'ci', at: AT, params: 'nope' as unknown as Record<string, unknown> }));
        expect(e.code).toBe('invalid-option');
        expect(e.path).toBe('request.params');
    });

    it('容器是领域态的**视图**：`Container.advance` 走出来的态也带着参数值（三样都拿得全）', () => {
        const c = createContainer(ciDef).advance({ to: 'ci', at: AT, params: { ci: { command: 'pnpm test' } } });
        expect(c.position).toBe('ci');
        expect(c.params).toEqual({ ci: { command: 'pnpm test' } });
        expect(c.done).toBe(false);
    });

    it('冻结深度：声明了参数 = 逐项受管（袋 / list 都冻结）；没声明 = 只冻顶层，内层照旧透传（##316 H-1 的已知差异）', () => {
        const { registry } = fakes();
        const declared = createRuntime(ciDef, { registry, params: { ci: { command: 'pnpm test' } } });
        expect(Object.isFrozen(declared.params)).toBe(true);
        expect(Object.isFrozen(declared.params.ci)).toBe(true);

        const solo = defineWorkflow({ nodes: [{ id: 'solo', name: '单', actor: 'system', guard: [], hint: '' }], edges: [] });
        const bagged = createRuntime(solo, { registry, params: { whatever: { deep: [1, 2] } } });
        expect(Object.isFrozen(bagged.params)).toBe(true); // 顶层冻
        expect(Object.isFrozen(bagged.params.whatever)).toBe(false); // 内层照旧是宿主那份（不越权管不认识的形状）
    });
});

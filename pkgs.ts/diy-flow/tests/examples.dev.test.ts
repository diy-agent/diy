// tests/examples.dev.test.ts — 范例①（`examples/dev.ts` + `examples/dev.plugins.ts`）的意图测试
//
// 需求（本文件即契约）：
//   D1 定义：6 泳道 ≡ 6 节点；入口唯一（clarify）；恰一条 bounce 边（review → implement）；
//      art 的 renderer 取引擎全集里的合法值；params 声明齐全（review.reviewers / review.maxBounces / ci.command）
//   D2 轨迹：只用**公开 API**端到端跑通 ##166 §14.3 的开发轨迹 —— **8 步 / 6 泳道 / 1 次打回**；
//      逐步断言领域态（`FlowState.path`）与审计侧重放（`project`）**逐步相等**
//   D3 有事件 / 无事件：`seed.id` 给了才落审计事件、才唤醒 notify；不给 = 纯领域推进 ⇒
//      两条跑的**领域态逐字节相同**（日志可清可丢，##333）
//   D4 领域态一等：跑完的态可落盘读回、可原样回喂 runtime；`project` 重建不出 params / done / ref
//   D5 参数层：hint 插值 · 插件按 `ctx.params[本节点 id]` 读值 · 参数值驱动宿主护栏（maxBounces）
//
// 风格：**只用包内公开 API**（`../src/index`，与其它意图测试一致）断言行为，不摸内核私有模块；
// 范例那边走 `@diy-agent/flow`（模拟外部工作流包的写法），两边解析到同一份模块。

import { describe, expect, it } from 'vitest';
// `Event` 的原语归 `@diy-agent/talk`（内核的 `Transition.event` 就复用它）—— 内核目前未再导出，故从依赖取
import type { Event } from '@diy-agent/talk';
import {
    FlowError,
    advance,
    createRegistry,
    createRuntime,
    flowStateFromJson,
    flowStateToJson,
    initialState,
    paramsOf,
    project,
    renderHint,
    resolveParams,
    type FlowState,
    type ParamValues,
    type StepResult,
    type Transition,
    type Visit,
} from '../src/index';
import { DEV_NODE_IDS, DEV_REF_KEY, DEV_TRACE, devWorkflow, type DevNodeId } from '../examples/dev';
import { registerDevPlugins, type DevFacts } from '../examples/dev.plugins';

const TASK_URI = 'projects/4/tasks/317';
const at = (n: number): string => `2026-10-13T00:00:${String(n).padStart(2, '0')}.000Z`;

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
    readonly to: DevNodeId;
    readonly by: 'system' | { readonly author: string; readonly content: string };
}

/** 轨迹的节点序 = `DEV_TRACE`；这里补上「谁推的」（与 `examples/dev.ts` 的定义同源） */
const STEPS: readonly Step[] = [
    { to: 'clarify', by: 'system' }, // 位置为空 ⇒ step 带入入口（进入口不是一条发言）
    { to: 'design', by: { author: '需求 agent', content: '需求澄清完，提交给设计' } },
    { to: 'implement', by: { author: '设计 agent', content: '方案与边界已定，开始开发' } },
    { to: 'review', by: { author: '开发 agent', content: '开发完成，提交给 Review' } },
    { to: 'implement', by: { author: 'Review agent', content: 'P0 未落点 → 打回' } }, // ← 唯一一次打回
    { to: 'review', by: { author: '开发 agent', content: 'P0 已落点，再次提交 Review' } },
    { to: 'ci', by: { author: 'Review agent', content: '复审通过，放行到 CI' } },
    { to: 'merge', by: 'system' }, // ci 的 guard 全可观测 ⇒ 系统自动推（无人发言）
];

interface Run {
    /** `states[0]` = 初始态；`states[i+1]` = 第 i 步之后的领域态 */
    readonly states: readonly FlowState<DevNodeId>[];
    readonly transitions: readonly Transition<DevNodeId>[];
    readonly events: readonly Event[];
    /** 折线走完后在 merge 上再 `step` 一次的结果（终态 `done`） */
    readonly end: StepResult<DevNodeId>;
    /** notify 插件被唤醒时收到的事件（没注册 notify 时恒为空） */
    readonly wakeups: readonly Event[];
}

/** 缺省实例值 = 声明里的 `default`（一个值都不填也要能跑：`ctx.params` 恒为全量） */
const defaults = (): ParamValues => resolveParams(paramsOf(devWorkflow));

interface RunOptions {
    /** `seed.id` 给不给：给了 = 落审计事件并唤醒 notify；缺省不给 = 纯领域推进 */
    readonly withEvents?: boolean;
    /** 本次运行的 L2 实例值（缺省 = 声明里的 default） */
    readonly params?: ParamValues;
    readonly facts?: DevFacts;
    readonly maxBounces?: number;
    /** 注册并唤醒一个 notify 插件（记账它收到的事件） */
    readonly notify?: boolean;
}

/** 端到端跑一遍轨迹：宿主侧的装配示范（**先注册齐、再 createRuntime**） */
function runTrack(options: RunOptions = {}): Run {
    const withEvents = options.withEvents ?? false;
    const params = options.params ?? defaults();
    const wakeups: Event[] = [];
    const registry = registerDevPlugins(createRegistry(), options.facts ?? {});
    if (options.notify) {
        registry.register('notify', 'dev_audit', (event) => {
            wakeups.push(event);
            return { delivered: ['dev_audit'] };
        });
    }
    const rt = createRuntime(devWorkflow, {
        registry,
        params,
        maxBounces: options.maxBounces ?? 2,
        notify: options.notify ? ['dev_audit'] : [],
    });

    let seq = 0;
    /** 一次调用的入参：`at` / `ref` 是领域事实；`id` / `content` 是审计材料 */
    const seed = (n: number, content = ''): { id?: string; at: string; ref: Record<string, string>; content: string } => {
        seq += 1;
        return withEvents
            ? { id: `e${seq}`, at: at(n), ref: { [DEV_REF_KEY]: TASK_URI }, content }
            : { at: at(n), ref: { [DEV_REF_KEY]: TASK_URI }, content };
    };

    const states: FlowState<DevNodeId>[] = [initialState<DevNodeId>()];
    const transitions: Transition<DevNodeId>[] = [];
    const events: Event[] = [];
    let state = states[0];

    STEPS.forEach((step, i) => {
        const result =
            step.by === 'system'
                ? rt.step(state, seed(i + 1))
                : {
                      status: 'moved' as const,
                      transition: rt.declare(state, { ...seed(i + 1, step.by.content), author: step.by.author, to: step.to }),
                  };
        if (result.status !== 'moved') throw new Error(`轨迹第 ${i + 1} 步应当走成 moved，实得 ${result.status}`);
        transitions.push(result.transition);
        if (result.transition.event) events.push(result.transition.event);
        state = result.transition.state;
        states.push(state);
    });

    return { states, transitions, events, end: rt.step(state, seed(STEPS.length + 1)), wakeups };
}

/** 收尾那次 `step` 的领域态（`moved` 与 `done` 都带 `state`；范例里不该收在 `stuck` / `awaiting-actor`） */
function endState(run: Run): FlowState<DevNodeId> {
    const end = run.end;
    if (end.status === 'done') return end.state;
    if (end.status === 'moved') return end.transition.state;
    throw new Error(`收尾 step 不该是 ${end.status}`);
}

/** 终态（折线走完后再 step 一次得到的 `done`）；不是 `done` 即说明范例跑偏，直接报 */
function finalState(run: Run): FlowState<DevNodeId> {
    if (run.end.status !== 'done') throw new Error(`期望终态 done，实得 ${run.end.status}`);
    return endState(run);
}

/** 折线上一条驻留的**领域事实**（`project` 重建得出的那四项；日志 id / 正文不在其中） */
const facts = (v: Visit<DevNodeId>): { node: string; seq: number; kind: string; at: string } => ({
    node: v.node,
    seq: v.seq,
    kind: v.kind,
    at: v.at,
});

/** 用领域正路（`advance`）把位置走到某几个节点（只为造一条已驻留的折线，不涉轨迹语义） */
function walkTo(params: ParamValues, nodes: readonly DevNodeId[]): FlowState<DevNodeId> {
    return nodes.reduce((state, to, i) => advance(devWorkflow, state, { to, at: at(i + 1), params }).state, initialState<DevNodeId>());
}

/** 取节点（范例定义里写死的 id，必存在） */
const nodeOf = (id: DevNodeId) => devWorkflow.nodes.find((n) => n.id === id) as (typeof devWorkflow.nodes)[number];

// ═══════════════════════════════════════════════════════════════

describe('D1 定义：6 泳道 ≡ 6 节点 · 一条 bounce 边 · art / params 齐全', () => {
    it('6 个节点就是 6 条泳道，入口唯一（clarify）', () => {
        expect(devWorkflow.nodes.map((n) => n.id)).toEqual([...DEV_NODE_IDS]);
        expect(devWorkflow.nodes.length).toBe(6);
        expect(devWorkflow.entry).toBe('clarify');
    });

    it('恰一条 bounce 边（review → implement）：打回不新建节点', () => {
        expect(devWorkflow.edges.filter((e) => e.kind === 'bounce')).toEqual([{ from: 'review', to: 'implement', kind: 'bounce' }]);
        expect(devWorkflow.nodes.length).toBe(6); // 结构不因打回增长
    });

    it('guard 的分水岭是可观测性：4 个 prompt（actor 宣布）+ pred / action（系统推）', () => {
        expect(nodeOf('clarify').guard).toEqual(['prompt:requirement_clear']);
        expect(nodeOf('design').guard).toEqual(['prompt:design_ready']);
        expect(nodeOf('implement').guard).toEqual(['prompt:dev_done']);
        expect(nodeOf('review').guard).toEqual(['prompt:review_done']);
        expect(nodeOf('ci').guard).toEqual(['pred:ci_green']);
        expect(nodeOf('merge').guard).toEqual(['action:pr_mergeable']);
        expect([nodeOf('ci').actor, nodeOf('merge').actor]).toEqual(['system', 'system']);
    });

    it('art 的 renderer 取引擎全集里的合法值（doc / diff / table / badge）', () => {
        expect(devWorkflow.nodes.filter((n) => n.art !== undefined).map((n) => [n.id, n.art?.renderer])).toEqual([
            ['design', 'doc'],
            ['implement', 'diff'],
            ['review', 'table'],
            ['ci', 'badge'],
        ]);
    });

    it('参数声明三项，全限定路径（实例值按节点分组）', () => {
        const schema = paramsOf(devWorkflow);
        expect(schema.schema.map((e) => e.path)).toEqual(['review.reviewers', 'review.maxBounces', 'ci.command']);
        expect(schema.defaults).toEqual({
            review: { reviewers: ['purple', 'owner'], maxBounces: 2 },
            ci: { command: 'npm run ci' },
        });
        expect(defaults()).toEqual(schema.defaults);
    });
});

describe('D2 轨迹复现（##166 §14.3：8 步 / 6 泳道 / 1 次打回）', () => {
    it('本范例要复现的节点序与轨迹表同源（`DEV_TRACE`）', () => {
        expect(STEPS.map((s) => s.to)).toEqual([...DEV_TRACE]);
    });

    it('8 步逐节点走完：折线 = DEV_TRACE，恰一次 bounce，打回后 implement / review 各驻留两次', () => {
        const path = runTrack({ withEvents: true }).states.at(-1)?.path ?? [];
        expect(path.map((v) => v.node)).toEqual([...DEV_TRACE]);
        expect(path.length).toBe(8);
        expect(path.map((v) => v.kind)).toEqual(['next', 'next', 'next', 'next', 'bounce', 'next', 'next', 'next']);
        expect(path.filter((v) => v.kind === 'bounce').length).toBe(1);
        expect(path.filter((v) => v.node === 'implement').map((v) => v.seq)).toEqual([1, 2]);
        expect(path.filter((v) => v.node === 'review').map((v) => v.seq)).toEqual([1, 2]);
        expect(devWorkflow.nodes.length).toBe(6); // 泳道数没变
    });

    it('逐步断言：每一步的领域态折线 == 审计侧重放（`project`）的同前缀结果', () => {
        const run = runTrack({ withEvents: true });
        expect(run.events.length).toBe(8);
        run.states.forEach((state, i) => {
            const replay = project(run.events.slice(0, i), devWorkflow);
            expect(replay.path.map(facts), `第 ${i} 步之后`).toEqual(state.path.map(facts));
            expect(replay.currentNode, `第 ${i} 步之后`).toBe(state.position);
        });
        expect(project(run.events, devWorkflow).visits).toEqual({
            clarify: 1,
            design: 1,
            implement: 2,
            review: 2,
            ci: 1,
            merge: 1,
        });
    });

    it('转移的结构化语义：entry / bounce / next；打回那步**一个插件都不调**', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[0].move).toEqual({ kind: 'entry', from: null, to: 'clarify' });
        expect(run.transitions[3].move).toEqual({ kind: 'next', from: 'implement', to: 'review' });
        expect(run.transitions[4].move).toEqual({ kind: 'bounce', from: 'review', to: 'implement' });
        expect(run.transitions[4].guard.evaluated).toBe(false); // 打回不主张推进 ⇒ 连求值都不做
        expect(run.transitions[7].move).toEqual({ kind: 'next', from: 'ci', to: 'merge' });
    });

    it('内核不编人类文本：正文由宿主给（宣布语），系统推的那条缺省空串', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[3].event?.content).toBe('开发完成，提交给 Review');
        expect(run.transitions[3].event?.author).toBe('开发 agent');
        expect(run.transitions[7].event?.author).toBe('system');
        expect(run.transitions[7].event?.content).toBe('');
    });

    it('merge 没有 next 出边 ⇒ 再 step 一次是 done（终态记进领域态，不重跑 action:）', () => {
        const final = finalState(runTrack({ withEvents: true }));
        expect(final.done).toBe(true);
        expect(final.path.length).toBe(8); // done 不是一次驻留
    });

    it('`status`（零副作用）报「现在轮到谁」：prompt 节点 = actor，system 节点 = system', () => {
        const run = runTrack();
        const rt = createRuntime(devWorkflow, { registry: registerDevPlugins(createRegistry()), params: defaults() });
        expect(run.states[1].position).toBe('clarify');
        expect(rt.status(run.states[1]).mode).toBe('actor');
        expect(rt.status(run.states[4]).mode).toBe('actor'); // review
        expect(rt.status(run.states[7]).mode).toBe('system'); // ci
        expect(rt.status(run.states[8]).mode).toBe('system'); // merge
        expect(rt.status(run.states[8]).outEdges).toEqual([]);
    });
});

describe('D3 有事件 / 无事件（日志可清可丢，##333）', () => {
    it('`seed.id` 给了才落事件、才唤醒 notify', () => {
        const run = runTrack({ withEvents: true, notify: true });
        expect(run.transitions.every((t) => t.event !== undefined)).toBe(true);
        expect(run.events.length).toBe(8);
        expect(run.wakeups.length).toBe(8);
        expect(run.transitions.every((t) => t.receipts[0]?.delivered.includes('dev_audit'))).toBe(true);
    });

    it('`seed.id` 不给 = 纯领域推进：无事件、无回执、notify 不唤醒 —— 但领域态逐字节相同', () => {
        const audited = runTrack({ withEvents: true, notify: true });
        const plain = runTrack({ withEvents: false, notify: true });
        expect(plain.transitions.every((t) => t.event === undefined)).toBe(true);
        expect(plain.events).toEqual([]);
        expect(plain.wakeups).toEqual([]);
        expect(plain.transitions.every((t) => t.receipts.length === 0)).toBe(true);
        // 关键断言：清掉日志 / 不唤醒通知，领域态一个字节不变（日志只是审计材料）
        expect(plain.states).toEqual(audited.states);
        expect(endState(plain)).toEqual(endState(audited));
    });
});

describe('D4 领域态一等：落盘读回 · 回喂 runtime · 重建不出的三样', () => {
    it('跑完的态可落盘读回，并原样回喂 runtime（状态文件是一等真源）', () => {
        const final = finalState(runTrack({ withEvents: true }));
        const restored = flowStateFromJson<DevNodeId>(flowStateToJson(final));
        expect(restored).toEqual(final);
        expect(restored.position).toBe('merge');
        expect(restored.params).toEqual(defaults());

        const rt = createRuntime(devWorkflow, { registry: registerDevPlugins(createRegistry()), params: restored.params });
        const again = rt.step(restored, { at: at(99) });
        expect(again.status).toBe('done');
        if (again.status === 'done') expect(again.state).toEqual(restored);
    });

    it('`project` 重建不出 params / done / ref（日志里没有）—— 要它们只能读状态文件', () => {
        const run = runTrack({ withEvents: true });
        const proj = project(run.events, devWorkflow);
        expect(proj.path.every((v) => v.ref === undefined)).toBe(true); // ① 宿主关联不在事件里
        expect('params' in proj).toBe(false); // ② L2 参数值不在事件里
        expect('done' in proj).toBe(false); // ③ 终态标记不在事件里

        const final = finalState(run);
        expect(final.done).toBe(true);
        expect(final.params).toEqual(defaults());
        expect(final.path.every((v) => v.ref?.[DEV_REF_KEY] === TASK_URI)).toBe(true);
    });

    it('领域正路（`advance`）同样产出完整真源；换一份参数值推进同一棵树 ⇒ 拒（另起一次运行）', () => {
        const params = defaults();
        const s1 = advance(devWorkflow, initialState<DevNodeId>(), { to: 'clarify', at: at(1), ref: { [DEV_REF_KEY]: TASK_URI }, params }).state;
        expect(s1.params).toEqual(params);
        expect(flowStateFromJson<DevNodeId>(flowStateToJson(s1))).toEqual(s1);

        const other = resolveParams(paramsOf(devWorkflow), { ci: { command: 'pnpm run ci' } });
        expect(caught(() => advance(devWorkflow, s1, { to: 'design', at: at(2), params: other })).code).toBe('invalid-param');
    });
});

describe('D5 参数层：声明在节点上 · 值按节点分组 · 宿主用它定护栏', () => {
    it('hint 插值：人看到的提示词带上了本次运行的值', () => {
        const params = resolveParams(paramsOf(devWorkflow), {
            review: { reviewers: ['alice', 'bob'] },
            ci: { command: 'pnpm run ci' },
        });
        expect(renderHint(nodeOf('review'), params)).toBe('独立复审（评审人：alice, bob）；P0/P1 打回，最多打回 2 次，全部有落点则放行');
        expect(renderHint(nodeOf('ci'), params)).toBe('跑 pnpm run ci，全绿才推');
    });

    it('插件按 `ctx.params[本节点 id]` 读到值（`ci_green` 读 `ci.command`）', () => {
        const params = resolveParams(paramsOf(devWorkflow), { ci: { command: 'pnpm run ci' } });
        const rt = createRuntime(devWorkflow, { registry: registerDevPlugins(createRegistry(), { ciGreen: false }), params });
        const stuck = rt.step(walkTo(params, ['clarify', 'design', 'implement', 'review', 'ci']), { at: at(9) });
        expect(stuck.status).toBe('stuck');
        if (stuck.status === 'stuck') expect(stuck.reason).toContain('pnpm run ci');
    });

    it('参数值驱动宿主护栏：`review.maxBounces = 0` ⇒ 第一次打回就 bounce-limit', () => {
        const params = resolveParams(paramsOf(devWorkflow), { review: { maxBounces: 0 } });
        const maxBounces = Number(params.review.maxBounces);
        expect(maxBounces).toBe(0);
        expect(caught(() => runTrack({ params, maxBounces })).code).toBe('bounce-limit');
    });

    it('`action:pr_mergeable` 不过 ⇒ 停在 merge（没有 bounce 边），不误报推进', () => {
        const params = defaults();
        const rt = createRuntime(devWorkflow, { registry: registerDevPlugins(createRegistry(), { prMergeable: false }), params });
        const stuck = rt.step(walkTo(params, ['clarify', 'design', 'implement', 'review', 'ci', 'merge']), { at: at(9) });
        expect(stuck.status).toBe('stuck');
    });
});

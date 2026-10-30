// tests/examples.video.test.ts — 范例②（`examples/video.ts` + `examples/video.plugins.ts`）的意图测试
//
// 需求（本文件即契约）：
//   V1 定义：9 泳道 ≡ 9 节点；入口唯一（topic）；恰一条 bounce 边（approve → cut）；
//      每个节点都有 `art`（= 一个 view），renderer 取引擎全集里的合法值，插件名与 demo 一致
//   V2 轨迹：只用**公开 API**端到端跑通 ##166 §14.3 的视频轨迹 —— **12 步 / 9 泳道 / 1 次打回**；
//      逐步断言领域态（`FlowState.path`）与审计侧重放（`project`）**逐步相等**
//   V3 view：每个节点的 `view`（renderer id + data 形状）—— **行业只写形状翻译，不写页面**（##166 §14.7）：
//      带 `render` 插件的节点由插件把行业 raw 翻成渲染器 data；不带的直接吃 raw（引擎默认渲染器）
//   V4 有事件 / 无事件：`seed.id` 给了才落审计事件、才唤醒 notify；不给 = 纯领域推进 ⇒ 领域态逐字节相同
//
// 风格：只用包内公开 API（`../src/index`）+ 契约类型（`../src/index` —— 即包公开面导出的 `src/view.ts` 形状）断言行为，不摸内核私有模块；
// 范例那边走 `@diy-agent/flow`（模拟外部工作流包的写法），两边解析到同一份模块。

import { describe, expect, it } from 'vitest';
import type { Event } from '@diy-agent/talk';
import { nodeAnchor } from '@diy-agent/talk';
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
    type DocData,
    type TableData,
    type TimelineData,
    type VideoData,
} from '../src/index';
import { VIDEO_NODE_IDS, VIDEO_REF_KEY, VIDEO_TRACE, videoWorkflow, type VideoNodeId } from '../examples/video';
import { VIDEO_NODE_DATA, registerVideoPlugins, type VideoFacts } from '../examples/video.plugins';

const TASK_URI = 'projects/4/tasks/318';
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
    readonly to: VideoNodeId;
    readonly by: 'system' | { readonly author: string; readonly content: string };
}

/** 轨迹的节点序 = `VIDEO_TRACE`；这里补上「谁推的」（与 `examples/video.ts` 的定义同源） */
const STEPS: readonly Step[] = [
    { to: 'topic', by: 'system' }, // 位置为空 ⇒ step 带入入口（进入口不是一条发言）
    { to: 'script', by: { author: '策划 agent', content: '选题定调：受众与差异化角度已写' } },
    { to: 'storyboard', by: { author: '编剧 agent', content: '脚本定稿，钩子 / 结构 / 落点齐备' } },
    { to: 'shoot', by: { author: '导演 agent', content: '分镜可用，时长预估 42s' } },
    { to: 'cut', by: { author: '人', content: '素材够用，签字放行' } },
    { to: 'render', by: { author: '剪辑 agent', content: '初剪完成，交转码' } },
    { to: 'approve', by: 'system' }, // render 的 guard 全可观测 ⇒ 系统自动推（无人发言）
    { to: 'cut', by: { author: '审片 agent', content: '前 3 秒节奏拖沓 → 打回重剪' } }, // ← 唯一一次打回
    { to: 'render', by: { author: '剪辑 agent', content: '前 3 秒重剪，再交转码' } },
    { to: 'approve', by: 'system' },
    { to: 'checks', by: { author: '审片 agent', content: '节奏、画面、配乐均可，通过' } },
    { to: 'publish', by: 'system' },
];

interface Run {
    /** `states[0]` = 初始态；`states[i+1]` = 第 i 步之后的领域态 */
    readonly states: readonly FlowState<VideoNodeId>[];
    readonly transitions: readonly Transition<VideoNodeId>[];
    readonly events: readonly Event[];
    /** 折线走完后在 publish 上再 `step` 一次的结果（终态 `done`） */
    readonly end: StepResult<VideoNodeId>;
    /** notify 插件被唤醒时收到的事件（没注册 notify 时恒为空） */
    readonly wakeups: readonly Event[];
}

interface RunOptions {
    /** `seed.id` 给不给：给了 = 落审计事件并唤醒 notify；缺省不给 = 纯领域推进 */
    readonly withEvents?: boolean;
    readonly facts?: VideoFacts;
    readonly maxBounces?: number;
    /** 注册并唤醒一个 notify 插件（记账它收到的事件） */
    readonly notify?: boolean;
}

/** 端到端跑一遍轨迹：宿主侧的装配示范（**先注册齐、再 createRuntime**） */
function runTrack(options: RunOptions = {}): Run {
    const withEvents = options.withEvents ?? false;
    const wakeups: Event[] = [];
    const registry = registerVideoPlugins(createRegistry(), options.facts ?? {});
    if (options.notify) {
        registry.register('notify', 'video_audit', (event) => {
            wakeups.push(event);
            return { delivered: ['video_audit'] };
        });
    }
    const rt = createRuntime(videoWorkflow, {
        registry,
        maxBounces: options.maxBounces ?? 2,
        notify: options.notify ? ['video_audit'] : [],
    });

    let seq = 0;
    /** 一次调用的入参：`at` / `ref` 是领域事实；`id` / `content` 是审计材料 */
    const seed = (
        n: number,
        content = '',
    ): { id?: string; at: string; ref: Record<string, string>; content: string } => {
        seq += 1;
        return withEvents
            ? { id: `e${seq}`, at: at(n), ref: { [VIDEO_REF_KEY]: TASK_URI }, content }
            : { at: at(n), ref: { [VIDEO_REF_KEY]: TASK_URI }, content };
    };

    const states: FlowState<VideoNodeId>[] = [initialState<VideoNodeId>()];
    const transitions: Transition<VideoNodeId>[] = [];
    const events: Event[] = [];
    let state = states[0];

    STEPS.forEach((step, i) => {
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

/** 收尾那次 `step` 的领域态（`moved` 与 `done` 都带 `state`；范例里不该收在 `stuck` / `awaiting-actor`） */
function endState(run: Run): FlowState<VideoNodeId> {
    const end = run.end;
    if (end.status === 'done') return end.state;
    if (end.status === 'moved') return end.transition.state;
    throw new Error(`收尾 step 不该是 ${end.status}`);
}

/** 终态（折线走完后再 step 一次得到的 `done`）；不是 `done` 即说明范例跑偏，直接报 */
function finalState(run: Run): FlowState<VideoNodeId> {
    if (run.end.status !== 'done') throw new Error(`期望终态 done，实得 ${run.end.status}`);
    return endState(run);
}

/** 折线上一条驻留的**领域事实**（`project` 重建得出的那四项；日志 id / 正文不在其中） */
const visitFact = (v: Visit<VideoNodeId>): { node: string; seq: number; kind: string; at: string } => ({
    node: v.node,
    seq: v.seq,
    kind: v.kind,
    at: v.at,
});

/** 取节点（范例定义里写死的 id，必存在） */
const nodeOf = (id: VideoNodeId) =>
    videoWorkflow.nodes.find((n) => n.id === id) as (typeof videoWorkflow.nodes)[number];

/** 用领域正路（`advance`）把位置走到某几个节点（只为造一条已驻留的折线，不涉轨迹语义） */
function walkTo(nodes: readonly VideoNodeId[]): FlowState<VideoNodeId> {
    return nodes.reduce(
        (state, to, i) => advance(videoWorkflow, state, { to, at: at(i + 1) }).state,
        initialState<VideoNodeId>(),
    );
}

// ── V3 用：把「节点 → 此刻能渲染出什么」这步装配出来（宿主侧的事，不是内核的事）────────

/** 只读一份注册表给 view 用（注册是纯装配，可共享） */
const RENDERS = registerVideoPlugins(createRegistry());

/**
 * 某个节点此刻能渲染出的 view。
 *
 * `art.plugin` 有 ⇒ 插件把行业 raw 翻成渲染器 data（**唯一需写代码处**）；
 * 没有 ⇒ raw 本身就是渲染器 data，引擎直接吃（`renderer` 仍由 `art` 声明）。
 */
function viewOf(id: VideoNodeId): View {
    const art = nodeOf(id).art;
    if (!art) throw new Error(`节点 ${id} 没有 art（范例不该如此）`);
    if (art.plugin === undefined || art.plugin === null)
        return { renderer: art.renderer, payload: VIDEO_NODE_DATA[id] };
    return RENDERS.resolve('render', art.plugin)(VIDEO_NODE_DATA[id], nodeAnchor(id));
}

// ═══════════════════════════════════════════════════════════════

describe('V1 定义：9 泳道 ≡ 9 节点 · 一条 bounce 边 · art / 插件齐全（与 demo 对齐）', () => {
    it('9 个节点就是 9 条泳道，入口唯一（topic）', () => {
        expect(videoWorkflow.nodes.map((n) => n.id)).toEqual([...VIDEO_NODE_IDS]);
        expect(videoWorkflow.nodes.length).toBe(9);
        expect(videoWorkflow.entry).toBe('topic');
    });

    it('恰一条 bounce 边（approve → cut）：打回不新建节点', () => {
        expect(videoWorkflow.edges.filter((e) => e.kind === 'bounce')).toEqual([
            { from: 'approve', to: 'cut', kind: 'bounce' },
        ]);
        expect(videoWorkflow.edges.length).toBe(9);
        expect(videoWorkflow.nodes.length).toBe(9); // 结构不因打回增长
    });

    it('guard 的分水岭是可观测性：6 个 prompt（actor 宣布）+ pred / action（系统推）', () => {
        expect(nodeOf('topic').guard).toEqual(['prompt:topic_ok']);
        expect(nodeOf('script').guard).toEqual(['prompt:script_ok']);
        expect(nodeOf('storyboard').guard).toEqual(['prompt:board_ok']);
        expect(nodeOf('shoot').guard).toEqual(['prompt:footage_ok']);
        expect(nodeOf('cut').guard).toEqual(['prompt:cut_ok']);
        expect(nodeOf('render').guard).toEqual(['pred:render_done']);
        expect(nodeOf('approve').guard).toEqual(['prompt:approve_ok']);
        expect(nodeOf('checks').guard).toEqual(['pred:duration_ok', 'pred:copyright_ok']);
        expect(nodeOf('publish').guard).toEqual(['action:publish']);
        expect(['render', 'checks', 'publish'].map((id) => nodeOf(id as VideoNodeId).actor)).toEqual([
            'system',
            'system',
            'system',
        ]);
        expect(['shoot'].map((id) => nodeOf(id as VideoNodeId).actor)).toEqual(['human']); // 「够不够用只有人能判」
    });

    it('每个节点都有 art（= 一个 view）：renderer 取引擎全集里的合法值（table / doc / timeline / video / badge）', () => {
        expect(VIDEO_NODE_IDS.map((id) => nodeOf(id).art?.renderer)).toEqual([
            'table',
            'doc',
            'timeline',
            'table',
            'video',
            'table',
            'table',
            'table',
            'badge',
        ]);
    });

    it('插件名与 demo 对齐，且每个 art.plugin 都真的注册了（先注册齐、再 createRuntime）', () => {
        expect(VIDEO_NODE_IDS.map((id) => nodeOf(id).art?.plugin ?? null)).toEqual([
            'render_topic',
            null,
            'render_board',
            null,
            'render_preview',
            'render_probe',
            'render_notes',
            'render_compliance',
            null,
        ]);
        // 每个 art.plugin 都真的注册了（`register` 的键序 = 注册序）
        expect(RENDERS.names('render')).toEqual([
            'render_topic',
            'render_board',
            'render_preview',
            'render_probe',
            'render_notes',
            'render_compliance',
        ]);
        for (const id of VIDEO_NODE_IDS) {
            const plugin = nodeOf(id).art?.plugin;
            if (plugin != null) expect(RENDERS.has('render', plugin), id).toBe(true);
        }
    });

    it('组合期就查插件名：漏注册 / 错字当场报（`unknown-plugin`），不留到走到那一步', () => {
        // 一个插件都不注册 ⇒ createRuntime 在组合期就报（不必等到「走到 render 那一步」）
        expect(caught(() => createRuntime(videoWorkflow, { registry: createRegistry() })).code).toBe('unknown-plugin');
        // 注册齐全就过（清单 = 范例自己声明的那几个）
        expect(() => createRuntime(videoWorkflow, { registry: registerVideoPlugins(createRegistry()) })).not.toThrow();
    });
});

describe('V2 轨迹复现（##166 §14.3：12 步 / 9 泳道 / 1 次打回）', () => {
    it('本范例要复现的节点序与轨迹表同源（`VIDEO_TRACE`）', () => {
        expect(STEPS.map((s) => s.to)).toEqual([...VIDEO_TRACE]);
    });

    it('12 步逐节点走完：折线 = VIDEO_TRACE，恰一次 bounce，打回后 cut / render / approve 各驻留两次', () => {
        const path = runTrack({ withEvents: true }).states.at(-1)?.path ?? [];
        expect(path.map((v) => v.node)).toEqual([...VIDEO_TRACE]);
        expect(path.length).toBe(12);
        expect(path.map((v) => v.kind)).toEqual([
            'next',
            'next',
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
        expect(path.filter((v) => v.node === 'cut').map((v) => v.seq)).toEqual([1, 2]);
        expect(path.filter((v) => v.node === 'render').map((v) => v.seq)).toEqual([1, 2]);
        expect(path.filter((v) => v.node === 'approve').map((v) => v.seq)).toEqual([1, 2]);
        expect(videoWorkflow.nodes.length).toBe(9); // 泳道数没变
    });

    it('逐步断言：每一步的领域态折线 == 审计侧重放（`project`）的同前缀结果', () => {
        const run = runTrack({ withEvents: true });
        expect(run.events.length).toBe(12);
        run.states.forEach((state, i) => {
            const replay = project(run.events.slice(0, i), videoWorkflow);
            expect(replay.path.map(visitFact), `第 ${i} 步之后`).toEqual(state.path.map(visitFact));
            expect(replay.currentNode, `第 ${i} 步之后`).toBe(state.position);
        });
        expect(project(run.events, videoWorkflow).visits).toEqual({
            topic: 1,
            script: 1,
            storyboard: 1,
            shoot: 1,
            cut: 2,
            render: 2,
            approve: 2,
            checks: 1,
            publish: 1,
        });
    });

    it('转移的结构化语义：entry / bounce / next；打回那步**一个插件都不调**', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[0].move).toEqual({ kind: 'entry', from: null, to: 'topic' });
        expect(run.transitions[6].move).toEqual({ kind: 'next', from: 'render', to: 'approve' });
        expect(run.transitions[7].move).toEqual({ kind: 'bounce', from: 'approve', to: 'cut' });
        expect(run.transitions[7].guard.evaluated).toBe(false); // 打回不主张推进 ⇒ 连求值都不做
        expect(run.transitions[11].move).toEqual({ kind: 'next', from: 'checks', to: 'publish' });
    });

    it('内核不编人类文本：正文由宿主给（宣布语），系统推的那条缺省空串', () => {
        const run = runTrack({ withEvents: true });
        expect(run.transitions[7].event?.content).toBe('前 3 秒节奏拖沓 → 打回重剪');
        expect(run.transitions[7].event?.author).toBe('审片 agent');
        expect(run.transitions[11].event?.author).toBe('system');
        expect(run.transitions[11].event?.content).toBe('');
    });

    it('publish 没有 next 出边 ⇒ 再 step 一次是 done（终态记进领域态，不重跑 action:）', () => {
        const final = finalState(runTrack({ withEvents: true }));
        expect(final.done).toBe(true);
        expect(final.path.length).toBe(12); // done 不是一次驻留
    });

    it('`status`（零副作用）报「现在轮到谁」：prompt 节点 = actor，system 节点 = system', () => {
        const run = runTrack();
        const rt = createRuntime(videoWorkflow, {
            registry: registerVideoPlugins(createRegistry()),
        });
        expect(run.states[1].position).toBe('topic');
        expect(rt.status(run.states[1]).mode).toBe('actor'); // topic（策划 agent 宣布）
        expect(rt.status(run.states[6]).mode).toBe('system'); // render（系统求值）
        expect(rt.status(run.states[7]).mode).toBe('actor'); // approve（审片 agent 宣布）
        expect(rt.status(run.states[12]).mode).toBe('system'); // publish
        expect(rt.status(run.states[12]).outEdges).toEqual([]);
    });

    it('外部世界说「没转完 / 不合规」⇒ 系统停在 render / checks 边上（不误报推进）', () => {
        const rtOf = (facts: VideoFacts) =>
            createRuntime(videoWorkflow, {
                registry: registerVideoPlugins(createRegistry(), facts),
                maxBounces: 2,
            });
        const stuck = rtOf({ renderDone: false }).step(
            walkTo(['topic', 'script', 'storyboard', 'shoot', 'cut', 'render']),
            { at: at(9) },
        );
        expect(stuck.status).toBe('stuck');
        if (stuck.status === 'stuck') expect(stuck.reason).toContain('ffprobe');
        const noCompliance = rtOf({ durationOk: false }).step(
            walkTo(['topic', 'script', 'storyboard', 'shoot', 'cut', 'render', 'approve', 'checks']),
            { at: at(9) },
        );
        expect(noCompliance.status).toBe('stuck');
    });
});

describe('V3 view：每个节点的 renderer id + data 形状（行业只写形状翻译，不写页面）', () => {
    it('9 个节点各产一个 view：插件产出的 renderer 与 `art.renderer` 声明一致', () => {
        for (const id of VIDEO_NODE_IDS) {
            const view = viewOf(id);
            expect(view.renderer, id).toBe(nodeOf(id).art?.renderer);
            expect(() => parseView(view), id).not.toThrow(); // 插件产物是**合法 View**（内核校验器说了算）
        }
    });

    it('6 个节点走 `render` 插件、3 个引擎直吃（doc / table / badge）—— 行业定制收敛在插件里', () => {
        const withPlugin = VIDEO_NODE_IDS.filter((id) => nodeOf(id).art?.plugin != null);
        expect(withPlugin).toEqual(['topic', 'storyboard', 'cut', 'render', 'approve', 'checks']);
        const direct = VIDEO_NODE_IDS.filter((id) => nodeOf(id).art?.plugin == null);
        expect(direct).toEqual(['script', 'shoot', 'publish']);
        expect(VIDEO_NODE_IDS.length).toBe(withPlugin.length + direct.length); // 9 = 6 + 3（人人有 view）
    });

    it('render_topic：选题卡 → table（受众 / 角度 / 钩子）', () => {
        const view = viewOf('topic');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.cells)).toEqual([
            ['受众', '24–30 岁通勤族'],
            ['角度', '反常识：越忙越要留白'],
            ['钩子', '前 3 秒抛结论'],
        ]);
    });

    it('script（无插件）：纯文本 → doc，raw 就是渲染器 data', () => {
        const view = viewOf('script');
        expect(view.renderer).toBe('doc');
        expect((view.payload as DocData).text).toContain('脚本');
    });

    it('render_board：分镜数组 → timeline（每镜一段 + 刻度）', () => {
        const view = viewOf('storyboard');
        const data = view.payload as TimelineData;
        expect(view.renderer).toBe('timeline');
        expect(data.items.map((i) => [i.label, i.start, i.end])).toEqual([
            ['开场钩子', 0, 18],
            ['问题铺陈', 18, 34],
            ['方法展开', 34, 62],
            ['案例演示', 62, 88],
            ['落点收束', 88, 100],
        ]);
        expect(data.ruler).toEqual(['0s', '15s', '30s', '45s']);
    });

    it('shoot（无插件）：素材清单 → table（抖动那条是 danger）', () => {
        const view = viewOf('shoot');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.tone)).toEqual(['ok', 'ok', 'danger']);
    });

    it('render_preview：成片文件 → video（播放器卡带播放头）', () => {
        const view = viewOf('cut');
        const data = view.payload as VideoData;
        expect(view.renderer).toBe('video');
        expect(data).toEqual({ poster: 'frame-0042.png', duration: 48, at: 12.4 });
    });

    it('render_probe：容器探测 → table（容器 / 码率 / 时长）', () => {
        const view = viewOf('render');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.cells)).toEqual([
            ['容器', 'mp4 / h264'],
            ['码率', '8.2 Mbps'],
            ['时长', '48 s'],
        ]);
    });

    it('render_notes：审片意见 → table（已重剪那条带 warn）', () => {
        const view = viewOf('approve');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.cells[0])).toEqual(['00:00–00:03', '00:12', '01:02']);
        expect(data.rows.map((r) => r.tone)).toEqual(['warn', undefined, undefined]);
    });

    it('render_compliance：合规检查 → table（三项全过）', () => {
        const view = viewOf('checks');
        const data = view.payload as TableData;
        expect(view.renderer).toBe('table');
        expect(data.rows.map((r) => r.tone)).toEqual(['ok', 'ok', 'ok']);
        expect(data.rows.map((r) => r.cells[0])).toEqual(['时长', '版权命中', '敏感词']);
    });

    it('publish（无插件）：投递回执 → badge', () => {
        const view = viewOf('publish');
        const data = view.payload as BadgeData;
        expect(view.renderer).toBe('badge');
        expect(data.badges.map((b) => b.tone)).toEqual(['ok', 'ok', 'warn']);
    });

    it('形状翻译是「真翻译」：raw 与 data 形态不同（不是把入参原样丢回去）', () => {
        const node = nodeOf('storyboard');
        expect(node.art?.raw).toBe('shots.json（每镜的起止与内容）');
        expect(viewOf('storyboard').payload).not.toEqual(VIDEO_NODE_DATA.storyboard); // shots → items
        expect(VIDEO_NODE_DATA).toHaveProperty('storyboard');
    });
});

describe('V4 有事件 / 无事件（日志可清可丢，##333）', () => {
    it('`seed.id` 给了才落事件、才唤醒 notify', () => {
        const run = runTrack({ withEvents: true, notify: true });
        expect(run.transitions.every((t) => t.event !== undefined)).toBe(true);
        expect(run.events.length).toBe(12);
        expect(run.wakeups.length).toBe(12);
        expect(run.transitions.every((t) => t.receipts[0]?.delivered.includes('video_audit'))).toBe(true);
    });

    it('`seed.id` 不给 = 纯领域推进：无事件、无回执、notify 不唤醒 —— 但领域态逐字节相同', () => {
        const audited = runTrack({ withEvents: true, notify: true });
        const plain = runTrack({ withEvents: false, notify: true });
        expect(plain.transitions.every((t) => t.event === undefined)).toBe(true);
        expect(plain.events).toEqual([]);
        expect(plain.wakeups).toEqual([]);
        expect(plain.transitions.every((t) => t.receipts.length === 0)).toBe(true);
        expect(plain.states).toEqual(audited.states);
        expect(endState(plain)).toEqual(endState(audited));
    });

    it('领域态一等：跑完的态可落盘读回并原样回喂 runtime；`ref` 随驻留走（日志里没有）', () => {
        const run = runTrack({ withEvents: true });
        const final = finalState(run);
        expect(final.path.every((v) => v.ref?.[VIDEO_REF_KEY] === TASK_URI)).toBe(true);
        expect(project(run.events, videoWorkflow).path.every((v) => v.ref === undefined)).toBe(true); // 关联不在事件里

        const rt = createRuntime(videoWorkflow, {
            registry: registerVideoPlugins(createRegistry()),
        });
        const again = rt.step(final, { at: at(99) });
        expect(again.status).toBe('done');
    });
});

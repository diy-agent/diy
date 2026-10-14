// tests/intent.flow.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 工作流内核「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（本文件即契约，依据 ##311 §一/§五、##166 §14.2/§14.3/§14.4）：
//   R1  类型护栏：`defineWorkflow` 的 `edges[].from/to` 只能取节点 id 的字面量联合 ——
//       打错字 / 回退到泳道**编译期报错**（用 `// @ts-expect-error` 断言非法 to 不通过）
//   R2  定义校验：节点重号 / 悬空边 / 同 (from,to) 重边 / 入口缺失或不唯一 一律抛 FlowError
//   R3  单指针不变量：容器恒只有一个「当前节点」，`apply` 返回新态（不可变），折线只增长不清空
//   R4  打回不增节点：一条 `bounce` 边只是让目标节点**再驻留一次**（`seq` 递增），节点数不变
//   R5  三场景轨迹投影：##166 §14.3 的三条完整轨迹（开发 8 步 / 视频 12 步 / 金融 10 步）逐节点复现
//   R6  非法转移一律报错：未进入口 / 未知节点 / 无对应边 / 事件 id 重复（带点路径定位）
//   R7  纯内核：不 import node:fs / electron / @diy/app，不取时间（at 由调用方传入）
//
// 测试风格：**以 ##166 §14.3 的真实工作流为素材**（开发 / 视频 / 金融），断言公开 API 的
// 行为与错误码，不断言内部实现。
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEvent, type Event } from '@diy/talk';
import { describe, expect, it } from 'vitest';
import {
    ACTORS,
    EDGE_KINDS,
    FlowError,
    apply,
    createContainer,
    defineWorkflow,
    findNode,
    initialState,
    isWorkflow,
    parseWorkflow,
    project,
    type EdgeDef,
    type WorkflowDef,
} from '../src/index';

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

let seq = 0;
/** 造一条「位置变更」事件：以 node 锚点指向目标节点（复用 @diy/talk 的 Event 原语） */
function move(to: string, opts: { author?: string; at?: string } = {}): Event {
    seq += 1;
    return createEvent({
        id: `e${seq}`,
        author: opts.author ?? 'agent',
        anchor: { type: 'node', data: { nodeId: to } },
        content: `→ ${to}`,
        at: opts.at ?? AT,
    });
}

/** 一串位置变更 → 事件流 */
function trace(nodes: readonly string[]): Event[] {
    return nodes.map((n) => move(n));
}

// ── 三个场景的定义（##166 §14.3：泳道数 = 节点数 6 / 9 / 7）──────────────────────

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

const videoDef = defineWorkflow({
    id: 'video',
    name: '视频制作工作流',
    nodes: [
        { id: 'topic', name: '选题', actor: 'agent', guard: ['prompt:topic_ok'], hint: '选题有受众假设' },
        { id: 'script', name: '脚本', actor: 'agent', guard: ['prompt:script_ok'], hint: '脚本完成' },
        { id: 'storyboard', name: '分镜', actor: 'agent', guard: ['prompt:board_ok'], hint: '分镜可用' },
        { id: 'shoot', name: '素材', actor: 'human', guard: ['prompt:footage_ok'], hint: '素材够用' },
        { id: 'cut', name: '剪辑', actor: 'agent', guard: ['prompt:cut_ok'], hint: '节奏满意' },
        { id: 'render', name: '转码', actor: 'system', guard: ['pred:render_done'], hint: 'ffprobe(out) 通过' },
        { id: 'approve', name: '审片', actor: 'agent', guard: ['prompt:approve_ok'], hint: '审美与合规的主观放行' },
        { id: 'checks', name: '合规', actor: 'system', guard: ['pred:duration_ok', 'pred:copyright_ok'], hint: '时长与版权都过' },
        { id: 'publish', name: '发布', actor: 'system', guard: ['action:publish'], hint: '投递到各平台' },
    ],
    edges: [
        { from: 'topic', to: 'script', kind: 'next' },
        { from: 'script', to: 'storyboard', kind: 'next' },
        { from: 'storyboard', to: 'shoot', kind: 'next' },
        { from: 'shoot', to: 'cut', kind: 'next' },
        { from: 'cut', to: 'render', kind: 'next' },
        { from: 'render', to: 'approve', kind: 'next' },
        { from: 'approve', to: 'cut', kind: 'bounce' },
        { from: 'approve', to: 'checks', kind: 'next' },
        { from: 'checks', to: 'publish', kind: 'next' },
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

const DEV_RUN = ['clarify', 'design', 'implement', 'review', 'implement', 'review', 'ci', 'merge'] as const;
const VIDEO_RUN = ['topic', 'script', 'storyboard', 'shoot', 'cut', 'render', 'approve', 'cut', 'render', 'approve', 'checks', 'publish'] as const;
const QUANT_RUN = ['fetch', 'factor', 'select', 'backtest', 'risk', 'select', 'backtest', 'risk', 'signoff', 'order'] as const;

// ═══════════════════════════════════════════════════════════════

describe('R1 类型护栏（##311 §一：唯一保留的护栏）', () => {
    // 节点字面量用 `as const` 固定 id 的**字面量类型**（等价于正常内联写法被 `const` 泛型推出来的结果）
    const twoNodes = [
        { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '…' },
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '…' },
    ] as const;
    const oneNode = [{ id: 'review', name: 'Review', actor: 'agent', guard: [], hint: '…' }] as const;

    // 把 edges 抽成形参，令「打错字的调用」短到能写在 `@ts-expect-error` 的**紧邻下一行**
    // （否则一换行，错误就不在指令覆盖面内 → TS2578）。
    const defTwo = (edges: readonly EdgeDef<'review' | 'implement'>[]) => defineWorkflow({ nodes: twoNodes, edges });
    const defOne = (edges: readonly EdgeDef<'review'>[]) => defineWorkflow({ nodes: oneNode, edges });

    it('合法定义：edges 取节点 id 的字面量联合，返回类型带 Id 联合', () => {
        const valid: WorkflowDef<'review' | 'implement'> = defTwo([{ from: 'review', to: 'implement', kind: 'bounce' }]);
        expect(valid.entry).toBe('review');
        expect(valid.nodes.length).toBe(2);
    });

    it('打错字 / 回退到泳道 → 编译期报错（运行期再兜一层 dangling-edge）', () => {
        // @ts-expect-error 非法 to：'implment' 不是节点 id（打错字）
        const badTo = caught(() => defTwo([{ from: 'review', to: 'implment', kind: 'next' }]));
        expect(badTo.code).toBe('dangling-edge');

        // @ts-expect-error 非法 from：'implement' 不在本定义的节点 id 里（回退到泳道）
        const badFrom = caught(() => defOne([{ from: 'implement', to: 'review', kind: 'next' }]));
        expect(badFrom.code).toBe('dangling-edge');
    });

    it('actor / kind / renderer 的全集由引擎枚举', () => {
        expect(ACTORS).toEqual(['agent', 'system', 'human']);
        expect(EDGE_KINDS).toEqual(['next', 'bounce']);
    });
});

describe('R2 定义校验（不静默）', () => {
    it('节点 id 重号 → duplicate-node', () => {
        const e = caught(() =>
            defineWorkflow({
                nodes: [
                    { id: 'a', name: 'A', actor: 'agent', guard: [], hint: '…' },
                    { id: 'a', name: 'A2', actor: 'agent', guard: [], hint: '…' },
                ],
                edges: [],
            }),
        );
        expect(e.code).toBe('duplicate-node');
        expect(e.path).toContain('nodes[1].id');
    });

    it('悬空边 → dangling-edge（运行期兜底编译期护栏）', () => {
        const def = { nodes: [{ id: 'a', name: 'A', actor: 'agent', guard: [], hint: '' }], edges: [{ from: 'a', to: 'x', kind: 'next' }] };
        expect(caught(() => parseWorkflow(def)).code).toBe('dangling-edge');
    });

    it('同 (from,to) 重边 → duplicate-edge（无 guard 求值时无法确定走哪条）', () => {
        const e = caught(() =>
            defineWorkflow({
                nodes: [
                    { id: 'a', name: 'A', actor: 'agent', guard: [], hint: '' },
                    { id: 'b', name: 'B', actor: 'agent', guard: [], hint: '' },
                ],
                edges: [
                    { from: 'a', to: 'b', kind: 'next' },
                    { from: 'a', to: 'b', kind: 'bounce' },
                ],
            }),
        );
        expect(e.code).toBe('duplicate-edge');
    });

    it('入口自动推断：没有边指向的节点即入口（三个场景各一）', () => {
        expect(devDef.entry).toBe('clarify');
        expect(videoDef.entry).toBe('topic');
        expect(quantDef.entry).toBe('fetch');
        expect(devDef.nodes.length).toBe(6);
        expect(videoDef.nodes.length).toBe(9);
        expect(quantDef.nodes.length).toBe(7);
    });

    it('入口不唯一 / 无入口 → 报错', () => {
        const multi = caught(() =>
            defineWorkflow({
                nodes: [
                    { id: 'a', name: 'A', actor: 'agent', guard: [], hint: '' },
                    { id: 'b', name: 'B', actor: 'agent', guard: [], hint: '' },
                ],
                edges: [],
            }),
        );
        expect(multi.code).toBe('multiple-entry');

        // 每个节点都有入边（环）→ 找不到入口
        const none = caught(() =>
            defineWorkflow({
                nodes: [
                    { id: 'a', name: 'A', actor: 'agent', guard: [], hint: '' },
                    { id: 'b', name: 'B', actor: 'agent', guard: [], hint: '' },
                ],
                edges: [
                    { from: 'a', to: 'b', kind: 'next' },
                    { from: 'b', to: 'a', kind: 'next' },
                ],
            }),
        );
        expect(none.code).toBe('no-entry');
    });

    it('explicit entry 覆盖自动推断', () => {
        const wf = defineWorkflow({
            entry: 'b',
            nodes: [
                { id: 'a', name: 'A', actor: 'agent', guard: [], hint: '' },
                { id: 'b', name: 'B', actor: 'agent', guard: [], hint: '' },
            ],
            edges: [{ from: 'b', to: 'a', kind: 'next' }],
        });
        expect(wf.entry).toBe('b');
    });

    it('isWorkflow / findNode 助手', () => {
        expect(isWorkflow(devDef)).toBe(true);
        expect(isWorkflow({ nodes: [] })).toBe(false);
        expect(findNode(devDef, 'review')?.name).toBe('Review');
        expect(findNode(devDef, 'nope')).toBeUndefined();
    });
});

describe('R3 单指针不变量', () => {
    it('初始态位置为空；apply 返回新态，旧态不受影响', () => {
        const s0 = initialState<'clarify' | 'design'>();
        expect(s0.position).toBeNull();
        expect(s0.path).toEqual([]);

        const s1 = apply(devDef, s0, move('clarify'));
        expect(s1.position).toBe('clarify');
        expect(s1.path.length).toBe(1);
        // 不可变：旧态纹丝不动
        expect(s0.position).toBeNull();
        expect(s0.path.length).toBe(0);
    });

    it('容器 apply(event) → 新容器（位置唯一推进，折线只增长）', () => {
        const c0 = createContainer(devDef);
        expect(c0.position).toBeNull();
        const c1 = c0.apply(move('clarify'));
        const c2 = c1.apply(move('design'));
        expect(c1.position).toBe('clarify');
        expect(c2.position).toBe('design');
        expect(c0.position).toBeNull();
        expect(c2.path.map((v) => v.node)).toEqual(['clarify', 'design']);
    });

    it('每次 apply 只移动一格（不会一次跳两步）', () => {
        const c = createContainer(devDef).apply(move('clarify'));
        const e = caught(() => c.apply(move('merge'))); // clarify → merge 无直连边
        expect(e.code).toBe('no-edge');
    });
});

describe('R4 打回不增节点（##166 §14.2 推论 2）', () => {
    it('bounce 边只是让目标节点再驻留一次：seq 递增、kind = bounce、节点数不变', () => {
        const nodesBefore = devDef.nodes.length;
        const proj = project(trace(['clarify', 'design', 'implement', 'review', 'implement']), devDef);

        const impl = proj.path.filter((v) => v.node === 'implement');
        expect(impl.map((v) => v.seq)).toEqual([1, 2]); // 第 2 次驻留
        expect(impl[0].kind).toBe('next');
        expect(impl[1].kind).toBe('bounce'); // 走的是一条 bounce 边
        expect(proj.visits.implement).toBe(2);
        expect(devDef.nodes.length).toBe(nodesBefore); // 结构不增长
        expect(proj.currentNode).toBe('implement');
    });
});

describe('R5 三场景轨迹投影（##166 §14.3）', () => {
    const cases: Array<[string, WorkflowDef<string>, readonly string[], number]> = [
        ['开发（8 步，1 次打回）', devDef, DEV_RUN, 4],
        ['视频（12 步，1 次打回）', videoDef, VIDEO_RUN, 7],
        ['金融（10 步，1 次打回）', quantDef, QUANT_RUN, 5],
    ];

    it.each(cases)('%s', (_name, def, run, bounceIndex) => {
        const proj = project(trace(run), def);

        // 折线逐节点复现
        expect(proj.path.map((v) => v.node)).toEqual([...run]);
        expect(proj.currentNode).toBe(run[run.length - 1]);
        expect(proj.path.length).toBe(run.length);

        // 恰一次打回（第 bounceIndex 条驻留走的 bounce 边），其余均为 next
        const kinds = proj.path.map((v) => v.kind);
        expect(kinds[bounceIndex]).toBe('bounce');
        expect(kinds.filter((k) => k === 'bounce').length).toBe(1);

        // 打回后目标节点第 2 次驻留
        expect(proj.visits[run[bounceIndex]]).toBe(2);
    });

    it('投影是纯函数：同一输入两次调用恒等，且不改 def', () => {
        const events = trace(DEV_RUN);
        expect(project(events, devDef)).toEqual(project(events, devDef));
        expect(devDef.nodes.length).toBe(6);
    });
});

describe('R6 非法转移一律报错（带点路径）', () => {
    it('首个事件未进入口 → invalid-entry', () => {
        const e = caught(() => project(trace(['design']), devDef));
        expect(e.code).toBe('invalid-entry');
        expect(e.path).toContain('anchor');
    });

    it('事件指向未知节点 → unknown-node', () => {
        expect(caught(() => project([move('nope')], devDef)).code).toBe('unknown-node');
    });

    it('无对应边（不许跳步）→ no-edge', () => {
        expect(caught(() => project(trace(['clarify', 'review']), devDef)).code).toBe('no-edge');
    });

    it('锚点不是 node（位置变更只能锚在泳道节点上）→ invalid-event', () => {
        const ev = createEvent({
            id: 'x',
            author: 'agent',
            anchor: { type: 'task-field', data: { field: 'title' } },
            content: '',
            at: AT,
        });
        expect(caught(() => project([ev], devDef)).code).toBe('invalid-event');
    });

    it('事件 id 重复 → duplicate-event-id', () => {
        const a = createEvent({ id: 'same', author: 'agent', anchor: { type: 'node', data: { nodeId: 'clarify' } }, content: '', at: AT });
        const b = createEvent({ id: 'same', author: 'agent', anchor: { type: 'node', data: { nodeId: 'design' } }, content: '', at: AT });
        expect(caught(() => project([a, b], devDef)).code).toBe('duplicate-event-id');
    });
});

describe('R7 纯内核（##311 §四）', () => {
    const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));

    it('不 import node:fs / electron / @diy/app', () => {
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const text = readFileSync(`${SRC_DIR}/${f}`, 'utf8');
            expect(text, `${f} 不应 import node:*`).not.toMatch(/from\s+['"]node:/);
            expect(text, `${f} 不应 import electron`).not.toMatch(/from\s+['"]electron['"]/);
            expect(text, `${f} 不应 import @diy/app`).not.toMatch(/from\s+['"]@diy\/app['"]/);
        }
    });

    it('不取时间（不 new Date / Date.now，at 由调用方传入）', () => {
        for (const f of files) {
            const text = readFileSync(`${SRC_DIR}/${f}`, 'utf8');
            expect(text, `${f} 不应取时间`).not.toMatch(/Date\.now|new Date\(/);
        }
    });
});

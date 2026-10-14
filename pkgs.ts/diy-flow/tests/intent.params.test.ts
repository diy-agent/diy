// tests/intent.params.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 参数层（L2）「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（依据 ##311 §二/§三.5、##166 §13.1、本任务 body ##316）：
//   R1  声明：参数写在节点定义里（`params`），局部名 + 全限定名 = `节点 id.局部名`；
//       类型全集 = `string | number | boolean | enum | list`（**引擎能画出一个控件的才收**）；
//       声明**形状封闭** —— 未知字段 / 未知类型 / 局部名带点 / enum 缺候选 / min>max /
//       default 类型不符 一律 `invalid-def`（作者写错一个字就得当场知道）
//   R2  实例值校验：类型错 / enum 不在候选 / number 越界 / NaN·Infinity / list 装非标量
//       → `invalid-param`；未知节点 / 未知参数名 → `unknown-param`（**绝不静默忽略**）
//   R3  默认合并：一个值都不填 = `defaults`（工作流照跑）；部分覆盖只盖给了的那些；
//       合并结果全量、冻结，并原样进 `ctx.params`（`guard` / 插件读到的就是它）
//   R4  `hint` 插值：`${局部名}` / `${节点 id.局部名}` / `$$` 转义；找不到参数 → `unknown-param`
//   R5  单向导出：`paramsOf(def)` 是纯 JSON 快照 `{ schema, defaults }`，round-trip 恒等；
//       `defaults` 只是派生视图（与 `schema` 不一致即报错，不当第二真源，§三.5）
//   R6  **只改值、不改形**：给全参数后节点 / 边数量不变；「跳过某步」= 参数让 `when` 短路，
//       不是删节点（同一份 def 跑出两条不同轨迹）
//
// 测试风格对齐本包现有意图测试：投喂定义 / 值，断言公开 API 的行为与错误码（`code` + 点路径）。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
    FlowError,
    PARAM_TYPES,
    createRegistry,
    createRuntime,
    defineWorkflow,
    initialState,
    interpolate,
    paramsOf,
    parseParamsSchema,
    parseWorkflow,
    renderHint,
    resolveParams,
    type ParamEntry,
    type ParamValue,
    type ParamValues,
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

const AT = '2026-10-15T00:00:00.000Z';
let seq = 0;
/** 内核不取时间、不生成 id → 种子由调用方给（同 ##313/##315） */
function nextSeed(): { id: string; at: string } {
    seq += 1;
    return { id: `p${seq}`, at: AT };
}

// ── 素材：带 L2 参数的开发工作流（##311 §二 里那三个例子：ci.command / review.maxBounces / review.reviewers）

const devDef = defineWorkflow({
    id: 'dev',
    name: '开发工作流（带 L2 参数）',
    entry: 'implement', // implement ↔ review 成环 ⇒ 两节点都有入边，入口须显式指明
    nodes: [
        {
            id: 'implement',
            name: '开发',
            actor: 'agent',
            guard: ['prompt:dev_done'],
            hint: '开发完成后提交给 Review',
        },
        {
            id: 'review',
            name: 'Review',
            actor: 'agent',
            guard: ['prompt:review_done'],
            hint: '评审人数 ${reviewers}，打回上限 ${maxBounces} 次',
            params: [
                {
                    name: 'maxBounces',
                    type: 'number',
                    label: '打回上限',
                    default: 3,
                    min: 0,
                    max: 10,
                    unit: '次',
                },
                { name: 'reviewers', type: 'list', label: '评审人', default: ['alice', 'bob'] },
                { name: 'autoApprove', type: 'boolean', label: '自动放行', default: false },
            ],
        },
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
    edges: [
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
        { from: 'review', to: 'ci', kind: 'next' },
        { from: 'ci', to: 'merge', kind: 'next' },
    ],
});

/** 只有 CI + 合并两节点：用来验证 `ctx.params` 真的到了插件手里 */
const checkDef = defineWorkflow({
    id: 'ci-only',
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

// ═══════════════════════════════════════════════════════════════

describe('R1 声明：节点上的 `params` 是唯一真源（##311 §二）', () => {
    it('类型全集 = 引擎能画出控件的五种', () => {
        expect(PARAM_TYPES).toEqual(['string', 'number', 'boolean', 'enum', 'list']);
    });

    it('全限定名 = 节点 id.局部名；label 缺省回退 name；顺序 = 节点序 / 声明序', () => {
        const schema = paramsOf(devDef);
        expect(schema.schema.map((entry) => entry.path)).toEqual([
            'review.maxBounces',
            'review.reviewers',
            'review.autoApprove',
            'ci.command',
        ]);
        // 没声明参数的节点（implement / merge）不进 schema
        expect(schema.schema.some((entry) => entry.node === 'implement' || entry.node === 'merge')).toBe(false);
        // label 缺省回退 name
        const noLabel = parseWorkflow({
            nodes: [
                {
                    id: 'a',
                    name: 'A',
                    actor: 'agent',
                    guard: [],
                    hint: '',
                    params: [{ name: 'topN', type: 'number', default: 5 }],
                },
            ],
            edges: [],
        });
        expect(paramsOf(noLabel).schema[0].label).toBe('topN');
        // 约束字段原样带出来（UI 表单要用）
        const maxBounces = schema.schema[0];
        expect(maxBounces).toEqual({
            node: 'review',
            name: 'maxBounces',
            path: 'review.maxBounces',
            type: 'number',
            label: '打回上限',
            default: 3,
            min: 0,
            max: 10,
            unit: '次',
        });
    });

    it('`defaults` 与实例值同构（{ 节点 id: { 局部名: 值 } }）', () => {
        expect(paramsOf(devDef).defaults).toEqual({
            review: { maxBounces: 3, reviewers: ['alice', 'bob'], autoApprove: false },
            ci: { command: 'npm test' },
        });
    });

    /** 造一份「一个节点 + 给定 params」的定义，专供非法声明用例 */
    const withParams = (params: unknown) => ({
        nodes: [{ id: 'a', name: 'A', actor: 'agent', guard: [], hint: '', params }],
        edges: [],
    });

    it('未知字段 → invalid-def（形状封闭，多一个键就报）', () => {
        const e = caught(() => parseWorkflow(withParams([{ name: 'x', type: 'string', default: 'y', 多写: 1 }])));
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[0].多写');
    });

    it('未知类型 → invalid-def', () => {
        const e = caught(() => parseWorkflow(withParams([{ name: 'x', type: 'object', default: {} }])));
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[0].type');
    });

    it('局部名含 `.` → invalid-def（点号是节点限定符）', () => {
        const e = caught(() => parseWorkflow(withParams([{ name: 'ci.command', type: 'string', default: '' }])));
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[0].name');
    });

    it('声明了参数的节点 id 含 `.` → invalid-def（否则 `${a.b.c}` 归属不明）', () => {
        const e = caught(() =>
            parseWorkflow({
                nodes: [
                    {
                        id: 'a.b',
                        name: 'A',
                        actor: 'agent',
                        guard: [],
                        hint: '',
                        params: [{ name: 'x', type: 'string', default: '' }],
                    },
                ],
                edges: [],
            }),
        );
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].id');
    });

    it('enum 缺候选 / 候选重复 / 给 enum 配 min → invalid-def', () => {
        expect(caught(() => parseWorkflow(withParams([{ name: 'x', type: 'enum', default: 'a' }]))).path).toBe(
            'workflow.nodes[0].params[0].enum',
        );
        expect(
            caught(() => parseWorkflow(withParams([{ name: 'x', type: 'enum', default: 'a', enum: ['a', 'a'] }]))).path,
        ).toBe('workflow.nodes[0].params[0].enum[1]');
        const e = caught(() =>
            parseWorkflow(withParams([{ name: 'x', type: 'enum', default: 'a', enum: ['a'], min: 1 }])),
        );
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[0].min');
    });

    it('用不上的约束写上来 → invalid-def（静默忽略 = 作者以为生效了）', () => {
        expect(
            caught(() => parseWorkflow(withParams([{ name: 'x', type: 'string', default: 'y', enum: ['y'] }]))).path,
        ).toBe('workflow.nodes[0].params[0].enum');
        expect(
            caught(() => parseWorkflow(withParams([{ name: 'x', type: 'boolean', default: true, unit: '个' }]))).path,
        ).toBe('workflow.nodes[0].params[0].unit');
    });

    it('number 约束：min > max → invalid-def；非有限数 → invalid-def', () => {
        const e = caught(() => parseWorkflow(withParams([{ name: 'x', type: 'number', default: 1, min: 5, max: 1 }])));
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[0].min');
        expect(
            caught(() =>
                parseWorkflow(withParams([{ name: 'x', type: 'number', default: 1, max: Number.POSITIVE_INFINITY }])),
            ).path,
        ).toBe('workflow.nodes[0].params[0].max');
    });

    it('default 必填且按类型校验（声明期就用运行期那套校验）', () => {
        expect(caught(() => parseWorkflow(withParams([{ name: 'x', type: 'string' }]))).path).toBe(
            'workflow.nodes[0].params[0].default',
        );
        expect(caught(() => parseWorkflow(withParams([{ name: 'x', type: 'string', default: 1 }]))).path).toBe(
            'workflow.nodes[0].params[0].default',
        );
        expect(
            caught(() => parseWorkflow(withParams([{ name: 'x', type: 'number', default: 11, max: 10 }]))).path,
        ).toBe('workflow.nodes[0].params[0].default');
        expect(
            caught(() => parseWorkflow(withParams([{ name: 'x', type: 'enum', default: 'z', enum: ['a', 'b'] }]))).path,
        ).toBe('workflow.nodes[0].params[0].default');
        expect(caught(() => parseWorkflow(withParams([{ name: 'x', type: 'boolean', default: 1 }]))).path).toBe(
            'workflow.nodes[0].params[0].default',
        );
        expect(caught(() => parseWorkflow(withParams([{ name: 'x', type: 'list', default: [['nested']] }]))).path).toBe(
            'workflow.nodes[0].params[0].default[0]',
        );
    });

    it('同一节点内参数重名 → invalid-def', () => {
        const e = caught(() =>
            parseWorkflow(
                withParams([
                    { name: 'x', type: 'string', default: '' },
                    { name: 'x', type: 'number', default: 1 },
                ]),
            ),
        );
        expect(e.code).toBe('invalid-def');
        expect(e.path).toBe('workflow.nodes[0].params[1].name');
    });
});

describe('R2 实例值校验（非法一律报，绝不静默降级）', () => {
    const schema = paramsOf(devDef);

    it('类型错 / 越界 / 非纯 JSON → invalid-param（带点路径指到那个值）', () => {
        const cases: Array<[string, unknown, string]> = [
            ['string 给数字', { ci: { command: 1 } }, 'values.ci.command'],
            ['number 给字符串', { review: { maxBounces: '3' } }, 'values.review.maxBounces'],
            ['number 越上界', { review: { maxBounces: 11 } }, 'values.review.maxBounces'],
            ['number 越下界', { review: { maxBounces: -1 } }, 'values.review.maxBounces'],
            ['NaN 不是纯 JSON', { review: { maxBounces: Number.NaN } }, 'values.review.maxBounces'],
            ['Infinity 不是纯 JSON', { review: { maxBounces: Number.POSITIVE_INFINITY } }, 'values.review.maxBounces'],
            ['boolean 给字符串', { review: { autoApprove: 'true' } }, 'values.review.autoApprove'],
            ['list 给标量', { review: { reviewers: 'alice' } }, 'values.review.reviewers'],
            ['list 装嵌套数组', { review: { reviewers: [['alice']] } }, 'values.review.reviewers[0]'],
            ['list 装对象', { review: { reviewers: [{ name: 'alice' }] } }, 'values.review.reviewers[0]'],
            ['节点值不是对象', { review: 'nope' }, 'values.review'],
            ['实例值不是对象', ['nope'], 'values'],
        ];
        for (const [name, values, path] of cases) {
            const e = caught(() => resolveParams(schema, values));
            expect(e.code, name).toBe('invalid-param');
            expect(e.path, name).toBe(path);
        }
    });

    it('enum：值必须在候选里', () => {
        const platformDef = defineWorkflow({
            nodes: [
                {
                    id: 'publish',
                    name: '发布',
                    actor: 'system',
                    guard: [],
                    hint: '平台 ${platform}',
                    params: [
                        {
                            name: 'platform',
                            type: 'enum',
                            label: '目标平台',
                            default: 'bilibili',
                            enum: ['bilibili', 'youtube'],
                        },
                    ],
                },
            ],
            edges: [],
        });
        const s = paramsOf(platformDef);
        expect(resolveParams(s, { publish: { platform: 'youtube' } }).publish.platform).toBe('youtube');
        const e = caught(() => resolveParams(s, { publish: { platform: 'tiktok' } }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('values.publish.platform');
        expect(e.message).toContain('bilibili | youtube');
    });

    it('未知节点 / 未知参数名 → unknown-param（形状封闭的另一半）', () => {
        const unknownNode = caught(() => resolveParams(schema, { nope: { x: 1 } }));
        expect(unknownNode.code).toBe('unknown-param');
        expect(unknownNode.path).toBe('values.nope');

        // implement 是节点，但没声明参数 ⇒ 它上面的键同样是未知参数
        const noParams = caught(() => resolveParams(schema, { implement: { x: 1 } }));
        expect(noParams.code).toBe('unknown-param');
        expect(noParams.path).toBe('values.implement');

        const unknownName = caught(() => resolveParams(schema, { ci: { cmmand: 'npm test' } }));
        expect(unknownName.code).toBe('unknown-param');
        expect(unknownName.path).toBe('values.ci.cmmand');
        expect(unknownName.message).toContain('ci 已声明：command');
    });

    it('参数值是纯 JSON：可 stringify 后原样回来（落库 / 表单改的前提）', () => {
        const resolved = resolveParams(schema, {
            review: { reviewers: ['alice'] },
            ci: { command: 'pnpm test' },
        });
        expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
    });
});

describe('R3 默认合并 + ctx.params 注入（##311 §二）', () => {
    const schema = paramsOf(devDef);

    it('一个值都不填 → 就是 defaults（工作流照跑）', () => {
        expect(resolveParams(schema)).toEqual(schema.defaults);
        expect(resolveParams(schema, {})).toEqual(schema.defaults);
    });

    it('部分覆盖：只盖给了的那些，其余落回 default', () => {
        const resolved = resolveParams(schema, { review: { maxBounces: 5 } });
        expect(resolved).toEqual({
            review: { maxBounces: 5, reviewers: ['alice', 'bob'], autoApprove: false },
            ci: { command: 'npm test' },
        });
    });

    it('合并结果全量且冻结（宿主对象改不动、插件也改不动）', () => {
        const host = { review: { maxBounces: 7 } };
        const resolved = resolveParams(schema, host);
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(Object.isFrozen(resolved.review)).toBe(true);
        expect(Object.isFrozen(resolved.review.reviewers)).toBe(true); // list 的缺省数组也冻上
        expect(host).toEqual({ review: { maxBounces: 7 } }); // 宿主对象未被写回
    });

    it('ctx.params 注入：guard 插件读到的是合并后的值（缺省值 / 覆盖值各跑一次）', () => {
        const seen: unknown[] = [];
        const registry = createRegistry().register('guard', 'check_green', (ctx) => {
            seen.push((ctx.params as Record<string, Record<string, ParamValue>>).ci.command);
            return { pass: true };
        });

        const withDefault = createRuntime(checkDef, { registry });
        expect(withDefault.params).toEqual({ ci: { command: 'npm test' } });
        const r1 = withDefault.step(initialState<'ci' | 'merge'>(), nextSeed());
        expect(r1.status).toBe('moved');
        if (r1.status !== 'moved') throw new Error('进入 ci 失败');
        expect(withDefault.step(r1.transition.state, nextSeed()).status).toBe('moved');

        const overridden = createRuntime(checkDef, {
            registry,
            params: { ci: { command: 'pnpm test' } },
        });
        const r2 = overridden.step(initialState<'ci' | 'merge'>(), nextSeed());
        if (r2.status !== 'moved') throw new Error('进入 ci 失败');
        expect(overridden.step(r2.transition.state, nextSeed()).status).toBe('moved');

        expect(seen).toEqual(['npm test', 'pnpm test']);
    });

    it('含非法参数的实例值在 createRuntime 就报（不留到插件读到 undefined）', () => {
        const registry = createRegistry().register('guard', 'check_green', () => ({ pass: true }));
        const e = caught(() => createRuntime(checkDef, { registry, params: { ci: { command: 42 } } }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('values.ci.command');
    });

    it('没声明任何参数的工作流：参数层未启用，`params` 仍是透传袋（##315 口径不回退）', () => {
        const solo = defineWorkflow({
            nodes: [{ id: 'solo', name: '单', actor: 'system', guard: [], hint: '' }],
            edges: [],
        });
        const host = { whatever: { deep: [1, 2] } };
        const rt = createRuntime(solo, { registry: createRegistry(), params: host });
        expect(rt.params).toEqual(host);
        expect(rt.params).not.toBe(host);
        expect(Object.isFrozen(rt.params)).toBe(true);

        const seen: ParamValues[] = [];
        const registry = createRegistry().register('guard', 'probe', (ctx) => {
            seen.push(ctx.params as ParamValues);
            return { pass: true };
        });
        const rt2 = createRuntime(
            defineWorkflow({
                nodes: [{ id: 'solo', name: '单', actor: 'system', guard: ['pred:probe'], hint: '' }],
                edges: [],
            }),
            { registry },
        );
        const r = rt2.step(initialState<'solo'>(), nextSeed());
        if (r.status !== 'moved') throw new Error('进入 solo 失败');
        rt2.step(r.transition.state, nextSeed());
        expect(seen).toEqual([{}]);
    });
});

describe('R4 hint 插值（提示词里读到参数）', () => {
    const schema = paramsOf(devDef);
    const params = resolveParams(schema, { review: { maxBounces: 5 } });
    const review = devDef.nodes.find((node) => node.id === 'review');
    if (!review) throw new Error('素材缺 review 节点');

    it('`${局部名}` 取本节点的参数；number / list 都写成一段文本', () => {
        expect(renderHint(review, params)).toBe('评审人数 alice, bob，打回上限 5 次');
    });

    it('`${节点 id.局部名}` 全限定引用任意节点的参数', () => {
        expect(interpolate('CI：${ci.command}（${review.maxBounces} 次打回内）', params)).toBe(
            'CI：npm test（5 次打回内）',
        );
    });

    it('`$$` 是字面量 `$`；孤立 `$` 原样保留', () => {
        expect(interpolate('$${command} 与 $5 与 ${ci.command}', params)).toBe('${command} 与 $5 与 npm test');
    });

    it('找不到参数 → unknown-param（绝不静默插空串）；未闭合 / 空插值 → invalid-param', () => {
        const missing = caught(() => interpolate('${nope}', params, { node: 'review' }));
        expect(missing.code).toBe('unknown-param');
        expect(missing.message).toContain('review.nope');

        const bare = caught(() => interpolate('${maxBounces}', params));
        expect(bare.code).toBe('unknown-param');
        expect(bare.message).toContain('全限定名');

        const unclosed = caught(() => interpolate('${maxBounces', params, { node: 'review' }));
        expect(unclosed.code).toBe('invalid-param');

        const empty = caught(() => interpolate('${}', params, { node: 'review' }));
        expect(empty.code).toBe('invalid-param');

        // 未声明参数的自由袋里可能是任意 JSON：插不进提示词的形状当场报（别渲染成 [object Object]）
        const blob = caught(() => interpolate('${solo.blob}', { solo: { blob: { a: 1 } } }));
        expect(blob.code).toBe('invalid-param');
        expect(blob.message).toContain('不是标量');
    });
});

describe('R5 单向导出：schema 快照（##311 §三.5）', () => {
    const schema = paramsOf(devDef);

    it('是纯 JSON：`JSON.stringify` → `parse` → `parseParamsSchema` round-trip 恒等', () => {
        const snapshot = JSON.parse(JSON.stringify(schema)) as unknown;
        expect(parseParamsSchema(snapshot)).toEqual(schema);
    });

    it('快照条目只带约定的键（无 undefined / 无多余字段）', () => {
        const snapshot = JSON.parse(JSON.stringify(schema)) as { schema: ParamEntry[] };
        const numberEntry = snapshot.schema.find((entry) => entry.path === 'review.maxBounces');
        expect(Object.keys(numberEntry ?? {}).sort()).toEqual([
            'default',
            'label',
            'max',
            'min',
            'name',
            'node',
            'path',
            'type',
            'unit',
        ]);
        const listEntry = snapshot.schema.find((entry) => entry.path === 'review.reviewers');
        expect(Object.keys(listEntry ?? {}).sort()).toEqual(['default', 'label', 'name', 'node', 'path', 'type']);
    });

    it('`defaults` 只是派生视图：与 schema 不一致即报（不当第二真源）', () => {
        const snapshot = JSON.parse(JSON.stringify(schema)) as {
            schema: unknown;
            defaults: Record<string, unknown>;
        };
        const e = caught(() => parseParamsSchema({ schema: snapshot.schema, defaults: {} }));
        expect(e.code).toBe('invalid-param');
        expect(e.path).toBe('params.defaults');
        expect(e.message).toContain('派生视图');
    });

    it('快照被改坏 → invalid-param（含 path 与 node.name 对不上）', () => {
        const snapshot = JSON.parse(JSON.stringify(schema)) as {
            schema: Array<Record<string, unknown>>;
            defaults: unknown;
        };
        const tampered = JSON.parse(JSON.stringify(snapshot.schema)) as Array<Record<string, unknown>>;
        tampered[0].path = 'x.y';
        const badPath = caught(() => parseParamsSchema({ schema: tampered, defaults: snapshot.defaults }));
        expect(badPath.code).toBe('invalid-param');
        expect(badPath.path).toBe('params.schema[0].path');

        const extra = JSON.parse(JSON.stringify(snapshot.schema)) as Array<Record<string, unknown>>;
        extra[0].多写 = 1;
        const badKey = caught(() => parseParamsSchema({ schema: extra, defaults: snapshot.defaults }));
        expect(badKey.code).toBe('invalid-param');
        expect(badKey.path).toBe('params.schema[0].多写');

        const badShape = caught(() => parseParamsSchema({ schema: snapshot.schema }));
        expect(badShape.code).toBe('invalid-param');
        expect(badShape.path).toBe('params.defaults');
    });

    it('导出的是数据不是代码：改快照不影响原定义（单向）', () => {
        const snapshot = JSON.parse(JSON.stringify(schema)) as {
            defaults: Record<string, Record<string, ParamValue>>;
        };
        snapshot.defaults.review.maxBounces = 99;
        expect(paramsOf(devDef).defaults.review.maxBounces).toBe(3);
    });
});

describe('R6 只改值、不改形（##311 §二硬约束）', () => {
    /** 「跳过某步」= 参数让边上的 `when` 短路；节点 / 边一个都不动 */
    const skipDef = defineWorkflow({
        id: 'may-skip-review',
        nodes: [
            {
                id: 'implement',
                name: '开发',
                actor: 'agent',
                guard: ['prompt:dev_done'],
                hint: '开发完提交 Review',
                params: [{ name: 'skipReview', type: 'boolean', label: '跳过 Review', default: false }],
            },
            {
                id: 'review',
                name: 'Review',
                actor: 'agent',
                guard: ['prompt:review_done'],
                hint: '独立复审',
            },
            {
                id: 'merge',
                name: '合并',
                actor: 'agent',
                guard: ['prompt:merge_done'],
                hint: '合并',
            },
        ],
        edges: [
            { from: 'implement', to: 'review', kind: 'next', when: 'pred:review_enabled' },
            { from: 'implement', to: 'merge', kind: 'next', when: 'pred:review_skipped' },
            { from: 'review', to: 'merge', kind: 'next' },
        ],
    });

    const flag = (ctx: { params: Readonly<Record<string, unknown>> }): boolean =>
        ((ctx.params.implement ?? {}) as Record<string, ParamValue>).skipReview === true;
    const registry = createRegistry()
        .register('guard', 'review_enabled', (ctx) => ({ pass: !flag(ctx) }))
        .register('guard', 'review_skipped', (ctx) => ({ pass: flag(ctx) }));

    type SkipId = 'implement' | 'review' | 'merge';

    /** 从入口走到某个目标节点，返回折线（目标边此刻不可用会抛 edge-unavailable） */
    function traceTo(values: Record<string, unknown>, to: SkipId): string[] {
        const rt = createRuntime(skipDef, { registry, params: values });
        const entered = rt.step(initialState<SkipId>(), nextSeed());
        if (entered.status !== 'moved') throw new Error('进入入口失败');
        const moved = rt.declare(entered.transition.state, {
            ...nextSeed(),
            author: '开发 agent',
            to,
            content: '',
        });
        return [entered.transition.state.position ?? 'entry', moved.state.position ?? 'entry'];
    }

    it('同一个布尔参数 ⇒ 两条不同轨迹，拓扑一个字没改', () => {
        const nodesBefore = skipDef.nodes.length;
        const edgesBefore = skipDef.edges.length;

        expect(traceTo({ implement: { skipReview: false } }, 'review')).toEqual(['implement', 'review']); // 正常
        expect(traceTo({ implement: { skipReview: true } }, 'merge')).toEqual(['implement', 'merge']); // 跳过

        expect(skipDef.nodes.length).toBe(nodesBefore);
        expect(skipDef.edges.length).toBe(edgesBefore);
    });

    it('参数为 false 时走不了「跳过」那条边（不是删边，是它此刻不可用）', () => {
        const rt = createRuntime(skipDef, {
            registry,
            params: { implement: { skipReview: false } },
        });
        const entered = rt.step(initialState<SkipId>(), nextSeed());
        if (entered.status !== 'moved') throw new Error('进入入口失败');
        const e = caught(() =>
            rt.declare(entered.transition.state, {
                ...nextSeed(),
                author: '开发 agent',
                to: 'merge',
                content: '',
            }),
        );
        expect(e.code).toBe('edge-unavailable');
        expect(e.path).toBe('edges[1].when');
    });

    it('参数只影响「值」：节点 / 边 / 参数声明本身不随参数变化', () => {
        const before = paramsOf(skipDef);
        resolveParams(before, { implement: { skipReview: true } });
        const after = paramsOf(skipDef);
        expect(after).toEqual(before);
        expect(after.schema.map((entry) => entry.path)).toEqual(['implement.skipReview']);
        expect(skipDef.nodes.map((node) => node.id)).toEqual(['implement', 'review', 'merge']);
    });
});

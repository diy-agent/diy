// tests/intent.talk.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 对话容器内核「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（本文件即契约，逐条对应 SPEC.md §1 的 R1–R7，依据 ##166 §一 结论 5/10/11/12）：
//   R1  role 铁律：他人的发言**绝不能**装配成 assistant；资料对谁都算 user；他人过程产物不得进装配；
//       非法来源类别（JS 调用方绕过类型）同样报错，不得静默降级
//   R2  doc-range 钉 revision：`{ revisionId, offset, quote }` 三字段缺一不可，rev 变了也报得出原版；
//       `pinsRevision` 三态（是否本修订 / 不同修订 / 不在修订轴）；锚点构造器一律自检
//   R3  JSON round-trip：序列化 → 反序列化恒等；键序固定（落盘 diff 友好）；`compact` 单行（jsonl 用）
//   R4  引用完整性：悬空 replyTo / 指向自己 / 重复 id / 异锚点混串 / 事件 causes 自指·重复 一律报错
//   R5  非法 anchor 一律拒绝：未知 type、缺 data、字段类型错、未知字段（带点路径定位）
//   R6  反序列化边界：非 JSON、缺字段（含 replyTo 键缺失）、未知字段（写侧拒绝 / 读侧可选放行）、at 非 ISO
//   R7  零依赖纯内核：不 import node:fs / electron / @diy/app，不取时间（at 由调用方传入）
//
// 测试风格：**以真实讨论形态为素材**（文档批注线、群争论线、工作流泳道节点），断言
// 公开 API 的行为与错误码，不断言内部实现。
// ═══════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    TalkError,
    ANCHOR_TYPES,
    SOURCE_KINDS,
    assemblyRole,
    assertRoleAssignments,
    assertThreadRefs,
    createEvent,
    createReaction,
    docRangeAnchor,
    eventFromJson,
    eventToJson,
    isAnchor,
    messageAnchor,
    nodeAnchor,
    parseAnchor,
    parseThread,
    pinsRevision,
    reactionFromJson,
    reactionToJson,
    taskFieldAnchor,
    threadFromJson,
    threadToJson,
    type Event,
    type Reaction,
} from '../src/index';

/** 捕获错误（断言分类 + 定位路径） */
function caught(fn: () => unknown): TalkError {
    try {
        fn();
    } catch (e) {
        if (e instanceof TalkError) return e;
        throw e;
    }
    throw new Error('期望抛出 TalkError，但调用成功了');
}

const AT = '2026-10-13T00:00:00.000Z';

/** 真实形态素材：任务 185 的文档批注线（##166 §7.2 —— b 评论第 32 行、c 同意并补充） */
function docThread(): Reaction[] {
    const target = docRangeAnchor('rev-7', 31 * 40, '此处有问题');
    return [
        createReaction({
            id: 'r1',
            author: 'b',
            turnId: 't1',
            target,
            content: '这一行漏了并发写保护',
            at: AT,
        }),
        createReaction({
            id: 'r2',
            author: 'c',
            turnId: 't1',
            target,
            replyTo: 'r1',
            content: '同意，且需要补一条锁顺序说明',
            at: AT,
        }),
        createReaction({
            id: 'r3',
            author: 'b',
            turnId: 't2',
            target,
            replyTo: 'r2',
            content: '已按此改',
            at: AT,
        }),
    ];
}

describe('R1 role 铁律（##166 结论 5）', () => {
    it('自己的发言 → assistant', () => {
        expect(assemblyRole({ kind: 'speech', author: 'a', self: 'a' })).toBe('assistant');
    });

    it('他人的发言 → user（绝不能是 assistant）', () => {
        expect(assemblyRole({ kind: 'speech', author: 'b', self: 'a' })).toBe('user');
    });

    it('文档修订（资料）→ user，谁写的都一样 —— 对模型是外部事实，不是有人跟我说话', () => {
        expect(assemblyRole({ kind: 'material', author: 'b', self: 'a' })).toBe('user');
        expect(assemblyRole({ kind: 'material', author: 'a', self: 'a' })).toBe('user');
    });

    it('过程产物（tool / thinking）：自己的 → assistant；他人的 → 报错（过程私有，不投递）', () => {
        expect(assemblyRole({ kind: 'trace', author: 'a', self: 'a' })).toBe('assistant');
        const e = caught(() => assemblyRole({ kind: 'trace', author: 'b', self: 'a' }));
        expect(e.code).toBe('role-violation');
    });

    it('非法来源类别 → role-violation，绝不静默降级成 speech（review1 意见 1）', () => {
        // JS 调用方 / as any 转发可绕过类型；运行时必须拦住，否则「他人 trace」会漏网
        expect(SOURCE_KINDS).toEqual(['speech', 'trace', 'material']);
        expect(caught(() => assemblyRole({ kind: 'speechh' as never, author: 'a', self: 'a' })).code).toBe(
            'role-violation',
        );
        const e = caught(() => assemblyRole({ kind: 'trace ' as never, author: 'b', self: 'a' }));
        expect(e.code).toBe('role-violation');
        expect(e.path).toBe('kind');
    });

    it('装配侧提交前核对：把他人发言标成 assistant 会被拦下', () => {
        const e = caught(() =>
            assertRoleAssignments([
                { kind: 'speech', author: 'a', self: 'a', role: 'assistant' },
                { kind: 'speech', author: 'b', self: 'a', role: 'assistant' }, // ← 违规
            ]),
        );
        expect(e.code).toBe('role-violation');
        expect(e.message).toContain('b');
    });

    it('正确的一批装配（自己 assistant + 他人 user）全部通过', () => {
        expect(() =>
            assertRoleAssignments([
                { kind: 'speech', author: 'a', self: 'a', role: 'assistant' },
                { kind: 'speech', author: 'b', self: 'a', role: 'user' },
                { kind: 'material', author: 'a', self: 'a', role: 'user' },
            ]),
        ).not.toThrow();
    });

    it('role 与来源不符也要报错：自己的发言标成 user 同样拦下', () => {
        const e = caught(() =>
            assertRoleAssignments([{ kind: 'speech', author: 'a', self: 'a', role: 'user' }]),
        );
        expect(e.code).toBe('role-violation');
        expect(e.path).toBe('[0].role');
    });
});

describe('R2 doc-range 钉 revision（##166 结论 11）', () => {
    it('锚点三个字段齐备：revisionId + offset + quote', () => {
        const anchor = docRangeAnchor('rev-7', 1240, '此处有问题');
        expect(anchor).toEqual({
            type: 'doc-range',
            data: { revisionId: 'rev-7', offset: 1240, quote: '此处有问题' },
        });
    });

    it('正文改版后仍报得出「这条批注针对哪一版」（只存 offset 就会漂）', () => {
        const anchor = docRangeAnchor('rev-7', 1240, '此处有问题');
        expect(pinsRevision(anchor, 'rev-7')).toBe(true);
        expect(pinsRevision(anchor, 'rev-9')).toBe(false);
        // quote 随锚点留存 —— 装配 / 宿主侧据此在当前版做 fuzzy 校正
        expect(parseAnchor(anchor).data).toMatchObject({
            revisionId: 'rev-7',
            quote: '此处有问题',
        });
    });

    it('pinsRevision 三态：非文档锚点返回 null（不在修订轴），不再静默当 true（review2 意见 1）', () => {
        expect(pinsRevision(messageAnchor('m-1'), 'rev-7')).toBeNull();
        expect(pinsRevision(taskFieldAnchor('body'), 'rev-7')).toBeNull();
        expect(pinsRevision(nodeAnchor('n1'), 'rev-7')).toBeNull();
    });

    it('锚点构造器一律自检：空标识 / 负偏移当场报错，不产出 isAnchor=false 的「Anchor」（review2 意见 5）', () => {
        expect(caught(() => nodeAnchor('')).code).toBe('invalid-anchor');
        expect(caught(() => messageAnchor('')).code).toBe('invalid-anchor');
        expect(caught(() => docRangeAnchor('', -1, '')).code).toBe('invalid-anchor');
        // 构造器产出必过校验
        expect(isAnchor(nodeAnchor('review'))).toBe(true);
        expect(isAnchor(docRangeAnchor('rev-7', 0, 'x'))).toBe(true);
    });

    it('缺 revisionId（只存 offset 的写法）→ invalid-anchor，路径指到字段', () => {
        const e = caught(() =>
            parseAnchor({ type: 'doc-range', data: { offset: 12, quote: 'x' } }),
        );
        expect(e.code).toBe('invalid-anchor');
        expect(e.path).toBe('anchor.data.revisionId');
    });

    it('offset 必须是非负整数；quote 不能为空串', () => {
        expect(
            caught(() =>
                parseAnchor({
                    type: 'doc-range',
                    data: { revisionId: 'r', offset: -1, quote: 'x' },
                }),
            ).path,
        ).toBe('anchor.data.offset');
        expect(
            caught(() =>
                parseAnchor({
                    type: 'doc-range',
                    data: { revisionId: 'r', offset: 1.5, quote: 'x' },
                }),
            ).code,
        ).toBe('invalid-anchor');
        expect(
            caught(() =>
                parseAnchor({ type: 'doc-range', data: { revisionId: 'r', offset: 0, quote: '' } }),
            ).path,
        ).toBe('anchor.data.quote');
    });

    it('四种锚点类型都能构造：message / doc-range / task-field / node（工作流容器只用换锚点类型）', () => {
        expect(ANCHOR_TYPES).toEqual(['message', 'doc-range', 'task-field', 'node']);
        expect(messageAnchor('m-3').type).toBe('message');
        expect(taskFieldAnchor('body').data).toEqual({ field: 'body' });
        expect(nodeAnchor('review').data).toEqual({ nodeId: 'review' });
    });
});

describe('R3 JSON round-trip（存储层的规范化出入口）', () => {
    it('Event 序列化 → 反序列化恒等', () => {
        const event = createEvent({
            id: 'e1',
            author: 'b',
            anchor: nodeAnchor('review'),
            content: '系统自动求值：ci 通过',
            causes: ['e2'],
            at: AT,
        });
        expect(eventFromJson(eventToJson(event))).toEqual(event);
    });

    it('Reaction 序列化 → 反序列化恒等（含 replyTo 与 doc-range 锚点）', () => {
        const [r1] = docThread();
        expect(reactionFromJson(reactionToJson(r1))).toEqual(r1);
    });

    it('整条 thread round-trip 恒等', () => {
        const thread = docThread();
        expect(threadFromJson(threadToJson(thread))).toEqual(thread);
    });

    it('compact 输出单行、可逐行 jsonl 组装与回读（review1 意见 4）', () => {
        const e1 = createEvent({ id: 'e1', author: 'b', anchor: nodeAnchor('review'), content: 'x', at: AT });
        const e2 = createEvent({ id: 'e2', author: 'c', anchor: nodeAnchor('review'), content: 'y', at: AT });
        const lines = [e1, e2].map((e) => eventToJson(e, { compact: true }));
        expect(lines.every((line) => !line.includes('\n'))).toBe(true);
        // 每行独立可解析（jsonl 的硬要求）
        expect(lines.map((line) => eventFromJson(line))).toEqual([e1, e2]);
        // thread 同样支持 compact
        const thread = docThread();
        expect(threadToJson(thread, { compact: true })).not.toContain('\n');
        expect(threadFromJson(threadToJson(thread, { compact: true }))).toEqual(thread);
    });

    it('键序固定：不同书写顺序的同一对象，序列化结果逐字节相同', () => {
        const a = reactionFromJson(
            JSON.stringify({
                id: 'r1',
                author: 'b',
                turnId: 't1',
                target: messageAnchor('m-1'),
                replyTo: null,
                content: 'x',
                at: AT,
            }),
        );
        const b = reactionFromJson(
            JSON.stringify({
                at: AT,
                content: 'x',
                replyTo: null,
                target: messageAnchor('m-1'),
                turnId: 't1',
                author: 'b',
                id: 'r1',
            }),
        );
        expect(reactionToJson(a)).toBe(reactionToJson(b));
    });
});

describe('R4 引用完整性：悬空 / 自指 / 重号 / 异锚点 / causes（##166 §7.4 痛点 2 的根因）', () => {
    it('正常回复链通过', () => {
        expect(() => assertThreadRefs(docThread())).not.toThrow();
    });

    it('replyTo 指向不存在的发言 → dangling-reply（结构化寻址才有这块护栏）', () => {
        const [r1, r2] = docThread();
        const e = caught(() => assertThreadRefs([r1, { ...r2, replyTo: 'r9-not-exists' }]));
        expect(e.code).toBe('dangling-reply');
        expect(e.path).toBe('[1].replyTo');
    });

    it('replyTo 指向自己 → dangling-reply', () => {
        const [r1] = docThread();
        const e = caught(() => assertThreadRefs([{ ...r1, replyTo: 'r1' }]));
        expect(e.code).toBe('dangling-reply');
    });

    it('thread 内 id 重复 → duplicate-id', () => {
        const [r1, r2] = docThread();
        const e = caught(() => assertThreadRefs([r1, { ...r2, id: 'r1' }]));
        expect(e.code).toBe('duplicate-id');
    });

    it('thread 内锚点不一致 → mixed-anchor（多条时间线不得混串，##166 §7.4 痛点 4 / review2 意见 2）', () => {
        const a = createReaction({ id: 'a', author: 'b', turnId: 't1', target: docRangeAnchor('rev-7', 0, 'x'), content: 'x', at: AT });
        const b = createReaction({ id: 'b', author: 'c', turnId: 't1', target: nodeAnchor('n1'), content: 'y', at: AT });
        const e = caught(() => assertThreadRefs([a, b]));
        expect(e.code).toBe('mixed-anchor');
        expect(e.path).toBe('[1].target');
        // 反序列化同样拦
        expect(caught(() => parseThread([a, b])).code).toBe('mixed-anchor');
    });

    it('事件 causes 自指 / 重复 → invalid-event（review1 意见 3）', () => {
        const base = { id: 'e1', author: 'a', anchor: nodeAnchor('n1'), content: 'x', at: AT };
        const self = caught(() => createEvent({ ...base, causes: ['e1'] }));
        expect(self.code).toBe('invalid-event');
        expect(self.path).toBe('event.causes[0]');
        const dup = caught(() => createEvent({ ...base, causes: ['e2', 'e2'] }));
        expect(dup.code).toBe('invalid-event');
        expect(dup.path).toBe('event.causes[1]');
    });

    it('assertThreadRefs 入口自检：replyTo 类型错 → invalid-reaction，不误报成 dangling-reply（review3 意见 3）', () => {
        const [r1] = docThread();
        const e = caught(() => assertThreadRefs([{ ...r1, replyTo: 123 } as unknown as Reaction]));
        expect(e.code).toBe('invalid-reaction');
        expect(e.path).toBe('[0].replyTo');
    });

    it('threadFromJson 也会拒绝悬空引用（读侧同样不静默）', () => {
        const json = JSON.stringify([
            {
                id: 'r1',
                author: 'b',
                turnId: 't1',
                target: nodeAnchor('n1'),
                replyTo: 'rX',
                content: '?',
                at: AT,
            },
        ]);
        expect(caught(() => threadFromJson(json)).code).toBe('dangling-reply');
    });
});

describe('R5 非法 anchor 一律拒绝（不静默丢弃）', () => {
    it('未知 type 报错并列出合法类型', () => {
        const e = caught(() => parseAnchor({ type: 'edge', data: {} }));
        expect(e.code).toBe('invalid-anchor');
        expect(e.path).toBe('anchor.type');
        expect(e.message).toContain('doc-range');
    });

    it('缺 data / data 非对象 / 字段类型错', () => {
        expect(caught(() => parseAnchor({ type: 'message' })).path).toBe('anchor.data');
        expect(caught(() => parseAnchor({ type: 'message', data: 3 })).code).toBe('invalid-anchor');
        expect(caught(() => parseAnchor({ type: 'message', data: { messageId: 3 } })).path).toBe(
            'anchor.data.messageId',
        );
        expect(caught(() => parseAnchor({ type: 'task-field', data: { field: '' } })).path).toBe(
            'anchor.data.field',
        );
    });

    it('未知字段 → invalid-anchor（形状封闭，写侧也绝不静默剥离，review2 意见 4）', () => {
        expect(caught(() => parseAnchor({ type: 'node', data: { nodeId: 'n1' }, extra: 1 })).path).toBe(
            'anchor.extra',
        );
        expect(caught(() => parseAnchor({ type: 'node', data: { nodeId: 'n1', extra: 1 } })).path).toBe(
            'anchor.data.extra',
        );
        expect(isAnchor({ type: 'node', data: { nodeId: 'n1' }, extra: 1 })).toBe(false);
    });

    it('事件里的锚点同样被校验（不是只看顶层）', () => {
        const e = caught(() =>
            createEvent({
                id: 'e1',
                author: 'a',
                anchor: { type: 'nope' } as never,
                content: 'x',
                at: AT,
            }),
        );
        expect(e.code).toBe('invalid-anchor');
        expect(e.path).toBe('event.anchor.type');
    });

    it('isAnchor 是探测用的非抛出版', () => {
        expect(isAnchor({ type: 'node', data: { nodeId: 'n1' } })).toBe(true);
        expect(isAnchor({ type: 'node', data: {} })).toBe(false);
        expect(isAnchor(null)).toBe(false);
    });
});

describe('R6 反序列化边界', () => {
    it('非 JSON 文本 → invalid-json', () => {
        expect(caught(() => eventFromJson('{ not json')).code).toBe('invalid-json');
    });

    it('缺字段 → 对应错误码 + 点路径', () => {
        const e = caught(() =>
            eventFromJson(
                JSON.stringify({ id: 'e1', author: 'a', anchor: messageAnchor('m'), content: 'x' }),
            ),
        );
        expect(e.code).toBe('invalid-event');
        expect(e.path).toBe('event.at');
    });

    it('replyTo 键缺失 → invalid-reaction；显式 null 才合法（review2 意见 3）', () => {
        const base = {
            id: 'r1',
            author: 'b',
            turnId: 't1',
            target: messageAnchor('m-1'),
            content: 'x',
            at: AT,
        };
        const e = caught(() => reactionFromJson(JSON.stringify(base)));
        expect(e.code).toBe('invalid-reaction');
        expect(e.path).toBe('reaction.replyTo');
        // 显式 null = 起头，合法
        expect(reactionFromJson(JSON.stringify({ ...base, replyTo: null })).replyTo).toBeNull();
    });

    it('at 非 ISO-8601 → 报错（时间是事实，格式也是事实，review1 意见 2）', () => {
        const e = caught(() => createEvent({ id: 'e1', author: 'a', anchor: nodeAnchor('n1'), content: 'x', at: '昨天下午' }));
        expect(e.code).toBe('invalid-event');
        expect(e.path).toBe('event.at');
        expect(
            caught(() => createReaction({ id: 'r1', author: 'a', turnId: 't1', target: nodeAnchor('n1'), content: 'x', at: '2026/10/13' })).code,
        ).toBe('invalid-reaction');
    });

    it('at 只校 ISO 形态、不校日历合法性：不存在的时刻也放行（review3 意见 2，内核不引 Date）', () => {
        // 词法成立即放行（99 月 / 99 日、越界时分、越界时区）；「时刻是否真实存在」属语义，归宿主
        const accept = (at: string) =>
            createEvent({ id: 'e1', author: 'a', anchor: nodeAnchor('n1'), content: 'x', at });
        expect(() => accept('2026-99-99T99:99:99Z')).not.toThrow();
        expect(() => accept('2026-02-30T25:00:00+99:99')).not.toThrow();
        // 反面对照：连形态都不成立的一律拒绝
        expect(caught(() => accept('2026-10-13')).code).toBe('invalid-event');
    });

    it('未知字段：写侧拒绝、读侧缺省拒绝、读侧 allowUnknown 放行（review2 意见 4）', () => {
        const event = createEvent({ id: 'e1', author: 'a', anchor: nodeAnchor('n1'), content: 'x', at: AT });
        // 写侧：绝不在落盘前静默抹掉调用方数据
        const writeErr = caught(() => eventToJson({ ...event, from: 'implement' } as unknown as Event));
        expect(writeErr.code).toBe('invalid-event');
        expect(writeErr.path).toBe('event.from');
        // 读侧缺省严格
        const json = JSON.stringify({ ...event, from: 'implement' });
        expect(caught(() => eventFromJson(json)).path).toBe('event.from');
        // 读侧显式放行（前向兼容：新版本加的字段）
        // review3 意见 1：allowUnknown 是「只读检查闸」—— 它只让解析不报错，**不保留**未知字段
        // （返回的仍是只含已知字段的规范化对象）。故读到的对象不得再经写侧落盘：读写往返不丢字段归宿主。
        const relaxed = eventFromJson(json, { allowUnknown: true });
        expect(Object.keys(relaxed)).toEqual(['id', 'author', 'anchor', 'content', 'causes', 'at']);
    });

    it('thread 反序列化要求数组', () => {
        expect(caught(() => threadFromJson('{"id":"r1"}')).code).toBe('invalid-reaction');
    });
});

describe('R7 零依赖纯内核（##311 §四：现在就能拆离成单独项目）', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

    it('src 不 import node:fs / electron / @diy/app，也不自己取时间', () => {
        const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const text = readFileSync(`${srcDir}${file}`, 'utf8');
            expect(text, `${file} 不应 import 宿主模块`).not.toMatch(
                /import[^\n]*from\s+['"](node:|electron|@diy\/app)/,
            );
            expect(text, `${file} 不应自己取时间（at 由调用方传入）`).not.toMatch(
                /\bDate\.now\b|new Date\(/,
            );
        }
    });

    it('package.json 零 dependencies', () => {
        const pkg = JSON.parse(
            readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
        ) as {
            dependencies: Record<string, string>;
        };
        expect(Object.keys(pkg.dependencies)).toEqual([]);
    });
});

// tests/intent.talk.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 对话容器内核「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（本文件即契约，逐条对应 SPEC.md §1 的 R1–R7，依据 ##166 §一 结论 5/10/11/12）：
//   R1  role 铁律：他人的发言**绝不能**装配成 assistant；资料对谁都算 user；他人过程产物不得进装配
//   R2  doc-range 钉 revision：`{ revisionId, offset, quote }` 三字段缺一不可，rev 变了也报得出原版
//   R3  JSON round-trip：序列化 → 反序列化恒等；键序固定（落盘 diff 友好）
//   R4  引用完整性：悬空 replyTo / 指向自己 / 重复 id 一律报错（结构化寻址的前提）
//   R5  非法 anchor 一律拒绝：未知 type、缺 data、字段类型错（带点路径定位）
//   R6  反序列化边界：非 JSON、缺字段、多余字段（多余丢弃、缺失报错）
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
    assemblyRole,
    assertRoleAssignments,
    assertThreadRefs,
    createEvent,
    createReaction,
    docRangeAnchor,
    eventFromJson,
    eventToJson,
    isAnchor,
    isOnRevision,
    messageAnchor,
    nodeAnchor,
    parseAnchor,
    reactionFromJson,
    reactionToJson,
    taskFieldAnchor,
    threadFromJson,
    threadToJson,
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
        expect(isOnRevision(anchor, 'rev-7')).toBe(true);
        expect(isOnRevision(anchor, 'rev-9')).toBe(false);
        // quote 随锚点留存 —— 装配 / 宿主侧据此在当前版做 fuzzy 校正
        expect(parseAnchor(anchor).data).toMatchObject({
            revisionId: 'rev-7',
            quote: '此处有问题',
        });
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

describe('R3 JSON round-trip（存储层的唯一出入口）', () => {
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

describe('R4 引用完整性：悬空 / 自指 / 重号（##166 §7.4 痛点 2 的根因）', () => {
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

    it('多余字段被丢弃（形状封闭 ⇒ 落盘稳定）', () => {
        const event = eventFromJson(
            JSON.stringify({
                id: 'e1',
                author: 'a',
                anchor: messageAnchor('m-1'),
                content: 'x',
                causes: [],
                at: AT,
                extra: 'drop me',
            }),
        );
        expect(Object.keys(event)).toEqual(['id', 'author', 'anchor', 'content', 'causes', 'at']);
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

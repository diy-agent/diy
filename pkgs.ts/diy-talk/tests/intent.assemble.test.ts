// tests/intent.assemble.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 装配器「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（本文件即契约，依据 ##166 §一 结论 1/4/13、§3.5 role 表、§五 取舍、§七 痛点 5/6）：
//   A1  一个装配器吃多源：同一份事件流 → 三种策略三种 messages（模式 = 一份装配策略，结论 4）
//   A2  role 铁律：他人的发言**绝不能**是 assistant（复用 ##312 role.ts，不在本任务重写）；
//       资料对谁都算 user；**他人的过程（tool/thinking）永不进入装配**（连 full 也不）
//   A3  三种内置策略：full（全量档案，含自己的过程）· text-only（去 tool/thinking、**保 replyTo 寻址**）
//       · changes-only（文档修订 + 批注线）
//   A4  存结构、装配时渲染（结论 13）：输入是 Reaction / Event 结构，装配时才渲染成字符串
//   A5  窗口 / 摘要是**注入式钩子**：宿主给裁剪函数，内核不自作主张（§五：真正的取舍点）
//   A6  非法输入一律抛 TalkError（未知策略 / 空 selfId / 源形状非法 / window 非函数 / 顶层未知字段），绝不静默（rule.loud）
//       附：A2「角色最终把关在 role.ts」与 A5「window 是宿主可信代码」是 review1 意见 1/2 的收口测试。
//
// 测试风格：以真实讨论形态为素材（群争论线 + 私有过程 + 文档批注线），断言公开 API 行为，不断言实现。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
    TalkError,
    assemble,
    assemblyRole,
    createEvent,
    createReaction,
    docRangeAnchor,
    messageAnchor,
    renderItem,
    resolveStrategy,
    type AssemblyStrategy,
    type Message,
    type Source,
} from '../src/index';

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
const SELF = 'a';

/** 真实形态素材：群争论线（模式 2，锚 message）+ 私有过程 + 文档批注线（模式 3，锚 doc-range） */
function sources(): Source[] {
    const msg = messageAnchor('m-1');
    const doc = docRangeAnchor('rev-7', 1240, '此处有问题');
    const line = [
        createReaction({ id: 'r1', author: 'b', turnId: 't1', target: msg, content: '边界不成立', at: AT }),
        createReaction({ id: 'r2', author: SELF, turnId: 't1', target: msg, replyTo: 'r1', content: '为何？', at: AT }),
        createReaction({ id: 'r3', author: 'c', turnId: 't1', target: msg, replyTo: 'r2', content: '我同意 b', at: AT }),
    ];
    const comments = [
        createReaction({ id: 'c1', author: 'b', turnId: 't2', target: doc, content: '这行漏了锁', at: AT }),
        createReaction({ id: 'c2', author: SELF, turnId: 't2', target: doc, replyTo: 'c1', content: '已补', at: AT }),
    ];
    return [
        { type: 'reactions', data: { reactions: line } },
        {
            type: 'trace',
            data: {
                events: [
                    createEvent({ id: 'ta', author: SELF, anchor: msg, content: 'rg 查了并发写保护', at: AT }),
                    createEvent({ id: 'tb', author: 'b', anchor: msg, content: 'b 的私有 tool 输出', at: AT }),
                ],
            },
        },
        { type: 'material', data: { events: [createEvent({ id: 'e1', author: 'b', anchor: doc, content: 'rev-7：补锁顺序说明', at: AT })] } },
        { type: 'reactions', data: { reactions: comments } },
    ];
}

const texts = (messages: readonly Message[]): string[] => messages.map((m) => m.content);

describe('A1 一个装配器吃多源（##166 结论 4：模式 = 一份装配策略）', () => {
    it('同一份事件流 → 三种策略三种 messages', () => {
        const src = sources();
        const full = assemble({ sources: src, strategy: 'full', selfId: SELF });
        const text = assemble({ sources: src, strategy: 'text-only', selfId: SELF });
        const changes = assemble({ sources: src, strategy: 'changes-only', selfId: SELF });
        expect(texts(full)).not.toEqual(texts(text));
        expect(texts(text)).not.toEqual(texts(changes));
        expect(texts(full)).not.toEqual(texts(changes));
    });

    it('三种策略的数量关系：full 含自己的过程，text-only 去之，changes-only 只留文档线', () => {
        const src = sources();
        // 发言 5（争论线 3 + 批注线 2）+ 自己的过程 1 + 资料 1 = 7；他人的过程（tb）不算
        expect(assemble({ sources: src, strategy: 'full', selfId: SELF })).toHaveLength(7);
        expect(assemble({ sources: src, strategy: 'text-only', selfId: SELF })).toHaveLength(6);
        // 资料 1 + 批注线 2 = 3（争论线锚 message、过程均被投影掉）
        expect(assemble({ sources: src, strategy: 'changes-only', selfId: SELF })).toHaveLength(3);
    });

    it('纯函数：同一输入两次装配结果相等，且不改入参', () => {
        const src = sources();
        const before = JSON.stringify(src);
        expect(assemble({ sources: src, strategy: 'full', selfId: SELF })).toEqual(
            assemble({ sources: src, strategy: 'full', selfId: SELF }),
        );
        expect(JSON.stringify(src)).toBe(before);
    });
});

describe('A2 role 铁律（复用 ##312 role.ts，不在本任务重写）', () => {
    it('他人的发言绝不出现 assistant（自己 assistant，他人 / 资料 user）', () => {
        for (const strategy of ['full', 'text-only', 'changes-only'] as const) {
            const messages = assemble({ sources: sources(), strategy, selfId: SELF });
            for (const m of messages) {
                if (m.content.startsWith('b: ') || m.content.startsWith('c: ')) {
                    expect(m.role, `${strategy}: ${m.content}`).toBe('user');
                }
            }
        }
    });

    it('自己的发言 → assistant；资料 → user（谁写的都一样）', () => {
        const messages = assemble({ sources: sources(), strategy: 'full', selfId: SELF });
        const bySelf = messages.find((m) => m.content.includes('为何？'));
        expect(bySelf?.role).toBe('assistant');
        const material = messages.find((m) => m.content.startsWith('【资料·'));
        expect(material?.role).toBe('user');
    });

    it('他人的过程（tool/thinking）永不进入装配 —— 连 full 也不（过程私有，不投递）', () => {
        const full = assemble({ sources: sources(), strategy: 'full', selfId: SELF });
        expect(texts(full).some((t) => t.includes('b 的私有 tool 输出'))).toBe(false);
    });

    it('该不变量不是装配器自创：role.ts 对他人过程同样抛 role-violation，且策略根本看不到它', () => {
        // 探针 probe5-foreign-trace-guard.mts（review1 意见 1 反驳）：最终把关在 ##312 的 assemblyRole
        expect(caught(() => assemblyRole({ kind: 'trace', author: 'b', self: SELF })).code).toBe('role-violation');
        // 即便写一个「全收」策略，也拿不到他人过程 —— 内核已先剔除，故无需、也不存在「放行开关」
        const seen: string[] = [];
        assemble({
            sources: sources(),
            strategy: {
                name: 'greedy',
                selectItem: (item) => {
                    seen.push(item.content);
                    return true;
                },
            },
            selfId: SELF,
        });
        expect(seen.some((c) => c.includes('b 的私有 tool 输出'))).toBe(false);
    });
});

describe('A3 三种内置策略', () => {
    it('full：只有**自己的**过程作为 assistant 进入（不含他人的）', () => {
        const messages = assemble({ sources: sources(), strategy: 'full', selfId: SELF });
        const processes = messages.filter((m) => m.content.startsWith('【过程·'));
        expect(processes).toHaveLength(1);
        expect(processes[0]!.role).toBe('assistant');
        expect(processes[0]!.content).toContain('rg 查了并发写保护');
    });

    it('text-only：tool / thinking 一条都不出现，但发言（含 replyTo 寻址）与资料保留', () => {
        const messages = texts(assemble({ sources: sources(), strategy: 'text-only', selfId: SELF }));
        expect(messages.some((t) => t.startsWith('【过程·'))).toBe(false);
        // 保留 replyTo 寻址（结论：模式 2 的争论线是有寻址的）
        expect(messages.some((t) => t.includes('[回复 r1]'))).toBe(true);
        expect(messages.some((t) => t.includes('[回复 c1]'))).toBe(true);
    });

    it('changes-only：只留资料（文档修订）+ 钉在文档上的批注线，去争论线与过程', () => {
        const messages = texts(assemble({ sources: sources(), strategy: 'changes-only', selfId: SELF }));
        expect(messages.some((t) => t.startsWith('【资料·'))).toBe(true);
        expect(messages.some((t) => t.includes('这行漏了锁'))).toBe(true);
        expect(messages.some((t) => t.includes('边界不成立'))).toBe(false); // 锚 message 的争论线被投影掉
        expect(messages.some((t) => t.startsWith('【过程·'))).toBe(false);
    });
});

describe('A4 存结构、装配时渲染（##166 结论 13）', () => {
    it('输入是 Reaction / Event 结构；渲染只发生在装配时（默认渲染带作者前缀与寻址）', () => {
        const messages = assemble({ sources: sources(), strategy: 'text-only', selfId: SELF });
        const line = messages.find((m) => m.content.includes('我同意 b'));
        expect(line).toEqual({ role: 'user', content: 'c: [回复 r2] 我同意 b' });
    });

    it('自定义 render 可换渲染，但改不动 role（铁律由装配器统一翻译）', () => {
        const kk: AssemblyStrategy = { name: 'kk', render: (item) => `<<${item.content}>>` };
        const messages = assemble({ sources: sources(), strategy: kk, selfId: SELF });
        expect(messages.find((m) => m.content === '<<我同意 b>>')?.role).toBe('user');
    });
});

describe('A5 窗口 / 摘要是注入式钩子（##166 §五：真正的取舍点）', () => {
    it('window 在渲染之后接手，可裁剪 / 前插摘要；内核不自作主张', () => {
        const messages = assemble({
            sources: sources(),
            strategy: 'full',
            selfId: SELF,
            window: (rendered) => [{ role: 'user', content: '（更早内容已摘要）' }, ...rendered.slice(-2)],
        });
        expect(messages).toHaveLength(3);
        expect(messages[0]).toEqual({ role: 'user', content: '（更早内容已摘要）' });
        expect(messages.at(-1)!.content).toContain('已补');
    });

    it('缺省 window：不裁剪（内核不替宿主做取舍）', () => {
        expect(assemble({ sources: sources(), strategy: 'full', selfId: SELF })).toHaveLength(7);
    });

    it('window 是宿主可信代码：返回值原样成为最终 messages（铁律保证仅覆盖 window 之前）', () => {
        // review1 意见 2②：Message 只含 role+content，丢失 author/kind 溯源 ⇒ 窗口后无法复核铁律；
        // 故显式声明边界 —— 装配器「他人发言绝不为 assistant」的保证止于 window 之前。
        const out = assemble({
            sources: sources(),
            strategy: 'full',
            selfId: SELF,
            window: () => [{ role: 'assistant', content: '宿主注入的摘要' }],
        });
        expect(out).toEqual([{ role: 'assistant', content: '宿主注入的摘要' }]);
    });
});

describe('A6 非法输入一律报错（rule.loud）', () => {
    it('未知策略名 → invalid-assembly', () => {
        const e = caught(() => assemble({ sources: [], strategy: 'fullx' as never, selfId: SELF }));
        expect(e.code).toBe('invalid-assembly');
        expect(e.path).toBe('strategy');
        expect(caught(() => resolveStrategy('nope' as never)).code).toBe('invalid-assembly');
    });

    it('selfId 为空 → invalid-assembly（没有「我」就无从判断哪条是自己的）', () => {
        const e = caught(() => assemble({ sources: [], strategy: 'full', selfId: '' }));
        expect(e.code).toBe('invalid-assembly');
        expect(e.path).toBe('selfId');
    });

    it('源形状非法（未知类型 / 未知字段）→ invalid-assembly，带点路径', () => {
        const bad = caught(() =>
            assemble({ sources: [{ type: 'speech', data: {} } as never], strategy: 'full', selfId: SELF }),
        );
        expect(bad.code).toBe('invalid-assembly');
        expect(bad.path).toBe('sources[0].type');
    });

    it('源内条目非法（缺字段事件）→ 由 parseEvent 报 invalid-event，带点路径', () => {
        const e = caught(() =>
            assemble({
                sources: [{ type: 'material', data: { events: [{ id: 'e1' } as never] } }],
                strategy: 'full',
                selfId: SELF,
            }),
        );
        expect(e.code).toBe('invalid-event');
        expect(e.path).toContain('sources[0].data.events[0]');
    });

    it('自定义策略对象形状非法（name 缺失 / selectItem 非函数）→ invalid-assembly', () => {
        expect(caught(() => resolveStrategy({} as never)).code).toBe('invalid-assembly');
        const e = caught(() => assemble({ sources: [], strategy: { name: 'x', selectItem: 1 } as never, selfId: SELF }));
        expect(e.code).toBe('invalid-assembly');
        expect(e.path).toBe('strategy.selectItem');
    });

    it('window 非函数 → invalid-assembly（不抛原生 TypeError）', () => {
        const e = caught(() => assemble({ sources: [], strategy: 'full', selfId: SELF, window: 1 as never }));
        expect(e.code).toBe('invalid-assembly');
        expect(e.path).toBe('window');
    });

    it('顶层未知字段 → invalid-assembly（window 误拼成 windo 不再静默失效）', () => {
        const e = caught(() => assemble({ sources: [], strategy: 'full', selfId: SELF, windo: () => [] } as never));
        expect(e.code).toBe('invalid-assembly');
        expect(e.path).toBe('assemble.windo');
    });

    it('renderItem 对四类锚点都能给出定位（资料 / 过程前缀）', () => {
        const ctx = { selfId: SELF };
        expect(renderItem({ kind: 'material', author: 'b', content: 'x', anchor: docRangeAnchor('rev-7', 1, 'q'), replyTo: null, at: AT }, ctx)).toContain('rev-7@1');
        expect(renderItem({ kind: 'speech', author: 'b', content: 'x', anchor: messageAnchor('m-1'), replyTo: 'r1', at: AT }, ctx)).toBe('b: [回复 r1] x');
    });
});

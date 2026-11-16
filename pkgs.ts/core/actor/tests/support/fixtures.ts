// fixtures.ts — 测试用的两个 kind。它们就是 docs/ 里示例的真实版本：
// 文档改了这里也得改（否则示例会烂）。
//
//   counterKind  串行 / 幂等 / 长活 / 事件 —— 单 actor 的执行语义
//   roomKind     多目标扇出 + 逐项状态 —— 「读不到 ≠ 没有」的正解

import { z } from 'zod';

import { defineKind } from '../../src/index.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 故意在 handler 中间让出事件循环：没有串行队列就会读丢（`n` 只会 +1） */
export const counterKind = defineKind({
    name: 'test.counter',
    state: z.object({ n: z.number().int() }),
    initial: () => ({ n: 0 }),
    events: { added: z.object({ by: z.number().int(), n: z.number().int() }) },
})
    .command(
        'add',
        { input: z.object({ by: z.number().int() }), output: z.object({ n: z.number().int() }) },
        async (ctx, input) => {
            const base = ctx.state.n;
            await tick();
            const n = base + input.by;
            return { output: { n }, state: { n }, events: [{ name: 'added', data: { by: input.by, n } }] };
        },
    )
    // 长活：handler 只受理，真正的工作排到队列尾
    .command(
        'slowAdd',
        {
            input: z.object({ by: z.number().int() }),
            output: z.object({ accepted: z.literal(true) }),
            mode: 'deferred',
        },
        (ctx, input) => {
            ctx.defer(async (inner) => {
                await tick();
                const n = inner.state.n + input.by;
                return { state: { n }, events: [{ name: 'added', data: { by: input.by, n } }] };
            });
            return { output: { accepted: true as const } };
        },
    )
    // 长活里失败：不能静默 —— 落 `$fault`，`$command.finished` 带 ok:false
    .command('slowFail', { input: z.object({}), output: z.void(), mode: 'deferred' }, (ctx) => {
        ctx.defer(async () => {
            throw new Error('boom');
        });
        return {};
    })
    .command('reset', { input: z.object({}), output: z.void() }, () => ({ state: { n: 0 } }))
    .query('get', { input: z.object({}), output: z.object({ n: z.number().int() }) }, (ctx) => ({ n: ctx.state.n }))
    .build();

/** 单个会话的“此刻在跑什么”——被 roster 扇出问的那个子查询 */
export const liveKind = defineKind({
    name: 'test.live',
    state: z.object({ label: z.string(), running: z.boolean() }),
    initial: () => ({ label: '', running: false }),
})
    .command(
        'set',
        { input: z.object({ label: z.string(), running: z.boolean() }), output: z.void() },
        (_ctx, input) => ({
            state: { label: input.label, running: input.running },
        }),
    )
    .query('live', { input: z.object({}), output: z.object({ label: z.string(), running: z.boolean() }) }, (ctx) => ({
        ...ctx.state,
    }))
    .build();

/** 房间：成员会话分散在不同 target 上，`roster` 必须扇出 */
export const roomKind = defineKind({
    name: 'test.room',
    state: z.object({ members: z.array(z.object({ memberId: z.string(), target: z.string() })) }),
    initial: () => ({ members: [] }),
})
    .command(
        'join',
        { input: z.object({ memberId: z.string(), target: z.string() }), output: z.void() },
        (ctx, input) => ({
            state: { members: [...ctx.state.members, input] },
        }),
    )
    .fanoutQuery('roster', {
        input: z.object({}),
        output: z.object({
            members: z.array(
                z.object({
                    memberId: z.string(),
                    // 三态：读到了在跑 / 读到了没跑 / **读不到**
                    state: z.enum(['running', 'idle', 'unknown']),
                    label: z.string().optional(),
                    reason: z.string().optional(),
                }),
            ),
        }),
        subquery: 'live',
        targets: (ctx) => ctx.state.members.map((m) => ({ target: m.target, memberId: m.memberId })),
        aggregate: ({ ctx, results }) => ({
            members: ctx.state.members.map((m) => {
                const hit = results.find((r) => r.target.memberId === m.memberId);
                if (!hit) return { memberId: m.memberId, state: 'unknown' as const, reason: 'E_UNAVAILABLE' };
                if (!hit.answered) return { memberId: m.memberId, state: 'unknown' as const, reason: hit.code };
                const value = hit.value as { label: string; running: boolean };
                return {
                    memberId: m.memberId,
                    state: value.running ? ('running' as const) : ('idle' as const),
                    label: value.label,
                };
            }),
        }),
    })
    .build();

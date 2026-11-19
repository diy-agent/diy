import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createContextSession } from '../src/session';
import { assertWireContinuity, volatileHits, type WireStep } from '../src/testing/wire';

/** 最小契约：两个原子单元（task.state / task.body / self） */
const schema = z.object({
    task: z.object({ state: z.string(), body: z.string() }),
    self: z.object({ tokens: z.number() }),
});

function make(initial?: { state: string; body: string; tokens: number }) {
    const values = initial ?? { state: 'open', body: '任务正文', tokens: 1 };
    const state = { task: { state: values.state, body: values.body }, self: { tokens: values.tokens } };
    const providers = [
        { key: 'task', provide: () => ({ ...state.task }) },
        { key: 'self', provide: () => ({ ...state.self }) },
    ];
    return { state, ctx: createContextSession({ providers, schema }) };
}

/** 模拟「宿主真正发出去的请求」：system + 已追加的消息 */
function wireOf(system: string, messages: readonly unknown[] = []): WireStep {
    return { system, messages: [{ role: 'system', content: system }, ...messages] };
}

describe('createContextSession：段内 system 逐字不变，变化只走 user 增量', () => {
    it('首轮 open 后，什么都没变 ⇒ step 不产消息（空串）', () => {
        const { ctx } = make();
        const open = ctx.open();
        expect(open.system).toContain('vars:');

        const step = ctx.step();
        expect(step.user).toBe('');
        expect(step.delta?.paths).toEqual([]);
        ctx.commit();
        expect(ctx.system).toBe(open.system);
    });

    it('★ 改一个任务字段：system 不动，增量只含该单元（不重发正文）', () => {
        const { ctx, state } = make();
        const open = ctx.open();
        ctx.step();
        ctx.commit();

        state.task.state = 'closed';
        const step = ctx.step();
        expect(step.delta?.paths).toEqual(['task.state']);
        expect(step.user).toContain('closed');
        expect(step.user).not.toContain('任务正文');
        expect(ctx.system).toBe(open.system);
        ctx.commit();

        // 字节连续性：上一步的消息是这一步的前缀，且只追加了一条
        const prev = wireOf(open.system);
        const next = wireOf(open.system, [{ role: 'user', content: step.user }]);
        expect(() => assertWireContinuity(prev, next)).not.toThrow();
    });

    it('★ 高频 self 变化：只走增量，system 不许出现用量字段', () => {
        const { ctx, state } = make();
        const open = ctx.open();
        expect(volatileHits(open.system)).toEqual([]);
        ctx.step();
        ctx.commit();

        state.self.tokens = 999;
        const step = ctx.step();
        expect(step.delta?.paths).toEqual(['self']);
        expect(step.user).toContain('999');
        expect(step.user).not.toContain('task');
        expect(ctx.system).toBe(open.system);
    });

    it('reset 后 open 重建 system（压缩换段的唯一入口）', () => {
        const { ctx, state } = make();
        const first = ctx.open();
        state.task.body = '新正文';
        ctx.reset();
        const second = ctx.open();
        expect(second.system).not.toBe(first.system);
        expect(second.system).toContain('新正文');
    });

    it('initialSnapshot：重启后第一轮就能算出「离开期间变了什么」', () => {
        const { ctx, state } = make();
        ctx.open();
        const snap = ctx.step().snapshot;
        state.task.state = 'closed';

        // 新进程：只有快照，没有 system；第一个 step 以快照为基准
        const resumed = createContextSession({
            providers: [
                { key: 'task', provide: () => ({ ...state.task }) },
                { key: 'self', provide: () => ({ tokens: 1 }) },
            ],
            schema,
            initialSnapshot: snap,
        });
        expect(resumed.system).toBe('');
        const step = resumed.step();
        expect(step.delta?.paths).toEqual(['task.state']);
    });
});

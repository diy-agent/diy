// ask.test.ts —— 提问闸门：发出即返回 / 回答 / 取消 / 超时。
//
// 核心不变量：request 绝不阻塞（否则整轮 run 挂在 promise 上，用户在等待期间插不进话）；
// 回答由房间消费（settle 带 owner），没有 promise 可回填。

import { describe, expect, it, vi } from 'vitest';

import { AskGate } from '../src/ask';
import type { AskRequest } from '../src/types';

function makeGate(options: { timeoutMs?: number } = {}) {
    const requests: AskRequest[] = [];
    const settled: Array<{
        request: AskRequest;
        result: { answer?: unknown; cancelled?: boolean; reason?: string };
        owner?: string;
    }> = [];
    const gate = new AskGate({
        request: (request) => requests.push(request),
        settle: (request, result, owner) =>
            settled.push({ request, result, ...(owner === undefined ? {} : { owner }) }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return { gate, requests, settled };
}

describe('AskGate', () => {
    it('发出即返回：request 同步拿到 askId，不等回答', () => {
        const h = makeGate();
        const request = h.gate.request({
            question: '先做哪个？',
            options: [
                { value: 'a', label: '方案 A' },
                { value: 'b', label: '方案 B' },
            ],
        });

        // 同步返回：工具靠这个立刻结束，run 不挂起
        expect(request.askId).toMatch(/^ask-/);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]?.kind).toBe('choice');
        // 卡片挂着等用户，没有"等待中的 promise"
        expect(h.gate.pendingCount()).toBe(1);
        expect(h.settled).toEqual([]);
    });

    it('回答：settle 收到 answer 和 owner，之后不再命中', () => {
        const h = makeGate();
        const request = h.gate.request({ question: '选哪个？' }, 'bot:a');

        expect(h.gate.answer(request.askId, { values: ['b'] })).toBe(true);
        expect(h.settled).toEqual([{ request, result: { answer: { values: ['b'] } }, owner: 'bot:a' }]);
        expect(h.gate.pendingCount()).toBe(0);
        // 重复回答不会二次投递
        expect(h.gate.answer(request.askId, { values: ['a'] })).toBe(false);
        expect(h.settled).toHaveLength(1);
    });

    it('表单题：fields 原样带回，kind 自动推断成 form', () => {
        const h = makeGate();
        const request = h.gate.request({
            question: '填一下发版信息',
            fields: [{ name: 'title', label: '标题', type: 'text', required: true }],
        });

        expect(request.kind).toBe('form');
        h.gate.answer(request.askId, { fields: { title: 'diy2 发版' } });
        expect(h.settled[0]?.result.answer).toEqual({ fields: { title: 'diy2 发版' } });
    });

    it('未知 askId：返回 false，不影响已有提问', () => {
        const h = makeGate();
        h.gate.request({ question: '随便问问' });
        expect(h.gate.answer('nope', { values: ['x'] })).toBe(false);
        expect(h.gate.pendingCount()).toBe(1);
    });

    it('cancelAll：清掉挂着的提问（容器关闭），不投递任何回答', () => {
        const h = makeGate();
        h.gate.request({ question: 'Q1' }, 'bot:a');
        h.gate.request({ question: 'Q2' }, 'bot:b');

        h.gate.cancelAll('容器已关闭');

        expect(h.gate.pendingCount()).toBe(0);
        expect(h.settled.map((entry) => entry.result)).toEqual([
            { cancelled: true, reason: '容器已关闭' },
            { cancelled: true, reason: '容器已关闭' },
        ]);
    });

    it('缺省一直等（用户随时可以回头答）；显式 timeoutMs 才过期', () => {
        vi.useFakeTimers();
        try {
            const forever = makeGate();
            forever.gate.request({ question: '一直等' });
            vi.advanceTimersByTime(24 * 60 * 60 * 1000);
            expect(forever.gate.pendingCount()).toBe(1);

            const timed = makeGate({ timeoutMs: 10 });
            const request = timed.gate.request({ question: '等一下' });
            vi.advanceTimersByTime(20);
            expect(timed.gate.pendingCount()).toBe(0);
            expect(timed.settled[0]).toMatchObject({ request, result: { cancelled: true, reason: '等待回答超时' } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('推不到界面上（emit 抛错）：当场收尾，不留孤儿卡片', () => {
        const settled: unknown[] = [];
        const gate = new AskGate({
            request: () => {
                throw new Error('界面已断开');
            },
            settle: (_request, result) => settled.push(result),
        });
        gate.request({ question: 'Q' });
        expect(gate.pendingCount()).toBe(0);
        expect(settled[0]).toMatchObject({ cancelled: true });
        expect(String((settled[0] as { reason?: string }).reason)).toContain('无法显示提问');
    });

    it('cancelFor：只清这个成员的提问，别人的照常等回答', () => {
        const h = makeGate();
        h.gate.request({ question: '我的' }, 'bot:a');
        const other = h.gate.request({ question: '别人的' }, 'bot:b');

        expect(h.gate.cancelFor('bot:a')).toBe(1);
        expect(h.gate.pendingCount()).toBe(1);

        expect(h.gate.answer(other.askId, { values: ['x'] })).toBe(true);
        expect(h.settled.map((entry) => entry.owner)).toEqual(['bot:a', 'bot:b']);
    });

    it('待回答有上限：满了就作废最旧的那条（新的仍要能显示）', () => {
        // 全 async 之后模型可以连着问；不封顶的话卡片和内存只增不减
        const h = makeGate();
        const requests = Array.from({ length: 21 }, (_, index) => h.gate.request({ question: `Q${index}` }));

        expect(h.gate.pendingCount()).toBe(20);
        // 淘汰的是最旧的（Q0），不是刚发出的那条
        expect(h.gate.list().map((request) => request.question)).not.toContain('Q0');
        expect(h.gate.list().map((request) => request.question)).toContain('Q20');
        expect(h.settled[0]).toMatchObject({ request: requests[0], result: { cancelled: true } });
        expect(String((h.settled[0] as { result: { reason?: string } }).result.reason)).toContain('最旧的一条已作废');
    });

    it('owner 跟着 request 走（卡片找不到工具行时靠它显示头像）', () => {
        const h = makeGate();
        const request = h.gate.request({ question: 'Q' }, 'bot:a');
        expect(request.owner).toBe('bot:a');
    });

    it('list() 返回挂起中的请求（刷新后恢复卡片用）', () => {
        const h = makeGate();
        h.gate.request({ question: 'Q1', options: [{ value: 'a', label: 'A' }] });
        expect(h.gate.list().map((request) => request.question)).toEqual(['Q1']);
    });
});

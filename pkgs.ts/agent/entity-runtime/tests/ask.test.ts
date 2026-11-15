// ask.test.ts —— 提问闸门：挂起 / 回答 / 取消 / 超时。

import { describe, expect, it } from 'vitest';

import { AskGate } from '../src/ask';
import type { AskRequest } from '../src/types';

function makeGate(options: { timeoutMs?: number } = {}) {
    const requests: AskRequest[] = [];
    const settled: Array<{ request: AskRequest; result: { answer?: unknown; cancelled?: boolean; reason?: string } }> =
        [];
    const gate = new AskGate({
        request: (request) => requests.push(request),
        settle: (request, result) => settled.push({ request, result }),
        timeoutMs: options.timeoutMs ?? 0,
    });
    return { gate, requests, settled };
}

describe('AskGate', () => {
    it('选项题：挂起直到回答，回答带 values', async () => {
        const h = makeGate();
        const pending = h.gate.request({
            question: '先做哪个？',
            options: [
                { value: 'a', label: '方案 A' },
                { value: 'b', label: '方案 B' },
            ],
        });

        expect(h.gate.pendingCount()).toBe(1);
        expect(h.requests[0]?.kind).toBe('choice');

        expect(h.gate.answer(h.requests[0]!.askId, { values: ['b'] })).toBe(true);
        const outcome = await pending;
        expect(outcome.answer).toEqual({ values: ['b'] });
        expect(outcome.request.question).toBe('先做哪个？');
        expect(h.settled[0]?.result.answer).toEqual({ values: ['b'] });
    });

    it('表单题：fields 原样带回，kind 自动推断成 form', async () => {
        const h = makeGate();
        const pending = h.gate.request({
            question: '填一下发版信息',
            fields: [{ name: 'title', label: '标题', type: 'text', required: true }],
        });

        expect(h.requests[0]?.kind).toBe('form');
        h.gate.answer(h.requests[0]!.askId, { fields: { title: 'diy2 发版' } });
        const outcome = await pending;
        expect(outcome.answer).toEqual({ fields: { title: 'diy2 发版' } });
    });

    it('未知 askId：返回 false，不影响已有提问', () => {
        const h = makeGate();
        void h.gate.request({ question: '随便问问' });
        expect(h.gate.answer('nope', { values: ['x'] })).toBe(false);
        expect(h.gate.pendingCount()).toBe(1);
    });

    it('cancelAll：挂起的提问按取消收尾（run 才能退出）', async () => {
        const h = makeGate();
        const a = h.gate.request({ question: 'Q1' });
        const b = h.gate.request({ question: 'Q2' });

        h.gate.cancelAll('本轮已取消');

        await expect(a).resolves.toMatchObject({ cancelled: true, reason: '本轮已取消' });
        await expect(b).resolves.toMatchObject({ cancelled: true });
        expect(h.gate.pendingCount()).toBe(0);
    });

    it('timeoutMs: 0 = 一直等；显式给值才超时（缺省 10 分钟）', async () => {
        const forever = makeGate({ timeoutMs: 0 });
        void forever.gate.request({ question: '一直等' });
        expect(forever.gate.pendingCount()).toBe(1);

        const timed = makeGate({ timeoutMs: 10 });
        const pending = timed.gate.request({ question: '等一下' });
        await expect(pending).resolves.toMatchObject({ cancelled: true, reason: '等待回答超时' });
    });

    it('推不到界面上（emit 抛错）：按取消收尾，不留孤儿', async () => {
        const gate = new AskGate({
            request: () => {
                throw new Error('界面已断开');
            },
            settle: () => undefined,
            timeoutMs: 0,
        });
        const outcome = await gate.request({ question: 'Q' });
        expect(outcome.cancelled).toBe(true);
        expect(outcome.reason).toContain('无法显示提问');
        expect(gate.pendingCount()).toBe(0);
    });

    it('list() 返回挂起中的请求（刷新后恢复卡片用）', () => {
        const h = makeGate();
        void h.gate.request({ question: 'Q1', options: [{ value: 'a', label: 'A' }] });
        expect(h.gate.list().map((request) => request.question)).toEqual(['Q1']);
    });
});

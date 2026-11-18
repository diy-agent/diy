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
        result: { answer?: unknown; cancelled?: boolean; reason?: string; notifyOwner?: boolean };
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
        expect(h.requests[0]?.questions[0]?.kind).toBe('choice');
        // 卡片挂着等用户，没有"等待中的 promise"
        expect(h.gate.pendingCount()).toBe(1);
        expect(h.settled).toEqual([]);
    });

    it('回答：settle 收到 answer 和 owner，之后不再命中', () => {
        const h = makeGate();
        const request = h.gate.request({ question: '选哪个？' }, 'bot:a');

        expect(h.gate.answer(request.askId, { answers: [{ id: 'q1', values: ['b'] }] })).toEqual({ ok: true });
        expect(h.settled).toEqual([{ request, result: { answer: { answers: [{ id: 'q1', values: ['b'] }] } }, owner: 'bot:a' }]);
        expect(h.gate.pendingCount()).toBe(0);
        // 重复回答不会二次投递
        expect(h.gate.answer(request.askId, { answers: [{ id: 'q1', values: ['a'] }] })).toEqual({ ok: false, code: 'no-such-ask' });
        expect(h.settled).toHaveLength(1);
    });

    it('表单题：fields 原样带回，kind 自动推断成 form', () => {
        const h = makeGate();
        const request = h.gate.request({
            question: '填一下发版信息',
            fields: [{ name: 'title', label: '标题', type: 'text', required: true }],
        });

        expect(request.questions[0]?.kind).toBe('form');
        h.gate.answer(request.askId, { answers: [{ id: 'q1', fields: { title: 'diy2 发版' } }] });
        expect(h.settled[0]?.result.answer).toEqual({ answers: [{ id: 'q1', fields: { title: 'diy2 发版' } }] });
    });

    it('未知 askId：返回 false，不影响已有提问', () => {
        const h = makeGate();
        h.gate.request({ question: '随便问问' });
        expect(h.gate.answer('nope', { answers: [{ id: 'q1', values: ['x'] }] })).toEqual({ ok: false, code: 'no-such-ask' });
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
            // 超时先不通知（缺省 timeoutMs=0，生产上不走这条路）；要通知也只该走 notifyOwner
            expect(timed.settled[0]?.result.notifyOwner).toBeUndefined();
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

    it('cancel(askId)：撤回一问，只影响那一条，且要告诉提问的成员', () => {
        // 「撤掉这一问」是用户对活着的一张卡的处置：提问的成员还在原地看（ask 不阻塞、
        // 没有 tool call 能回填），所以必须 notifyOwner —— 跟超时／容器关闭不一样。
        const h = makeGate();
        const first = h.gate.request({ question: '不想回答的这个' }, 'bot:a');
        const second = h.gate.request({ question: '还想回答的那个' }, 'bot:a');

        expect(h.gate.cancel(first.askId)).toBe(true);
        expect(h.gate.pendingCount()).toBe(1);
        expect(h.gate.list().map((request) => request.questions[0]?.question)).toEqual(['还想回答的那个']);
        expect(h.settled).toEqual([
            { request: first, result: { cancelled: true, reason: '提问已被撤回', notifyOwner: true }, owner: 'bot:a' },
        ]);

        // 撤回过的不能再答（否则会凭空冒出一条「回答提问」）
        expect(h.gate.answer(first.askId, { answers: [{ id: 'q1', values: ['x'] }] })).toEqual({ ok: false, code: 'no-such-ask' });
        expect(h.gate.answer(second.askId, { answers: [{ id: 'q1', values: ['x'] }] })).toEqual({ ok: true });
        expect(h.gate.pendingCount()).toBe(0);
    });

    it('cancelFor：只清这个成员的提问，别人的照常等回答', () => {
        const h = makeGate();
        h.gate.request({ question: '我的' }, 'bot:a');
        const other = h.gate.request({ question: '别人的' }, 'bot:b');

        expect(h.gate.cancelFor('bot:a')).toBe(1);
        expect(h.gate.pendingCount()).toBe(1);

        expect(h.gate.answer(other.askId, { answers: [{ id: 'q1', values: ['x'] }] })).toEqual({ ok: true });
        expect(h.settled.map((entry) => entry.owner)).toEqual(['bot:a', 'bot:b']);
    });

    it('待回答有上限：满了就作废最旧的那条（新的仍要能显示）', () => {
        // 全 async 之后模型可以连着问；不封顶的话卡片和内存只增不减
        const h = makeGate();
        const requests = Array.from({ length: 21 }, (_, index) => h.gate.request({ question: `Q${index}` }));

        expect(h.gate.pendingCount()).toBe(20);
        // 淘汰的是最旧的（Q0），不是刚发出的那条
        expect(h.gate.list().map((request) => request.questions[0]?.question)).not.toContain('Q0');
        expect(h.gate.list().map((request) => request.questions[0]?.question)).toContain('Q20');
        expect(h.settled[0]).toMatchObject({ request: requests[0], result: { cancelled: true } });
        expect(String((h.settled[0] as { result: { reason?: string } }).result.reason)).toContain('最旧的一条已作废');
        // 关键：淘汰必须告诉提问的成员（notifyOwner），否则它那边永远留着一个没有下文的提问。
        // 其他取消（超时 / 容器关闭 / 成员离开）不告诉：收件人已经没了。
        expect(h.settled[0]?.result.notifyOwner).toBe(true);
        expect(h.settled.slice(1)).toEqual([]);
    });

    it('owner 跟着 request 走（卡片找不到工具行时靠它显示头像）', () => {
        const h = makeGate();
        const request = h.gate.request({ question: 'Q' }, 'bot:a');
        expect(request.owner).toBe('bot:a');
    });

    it('一批多题：一次 request 带三题，一次 answer 整批回传（这就是"点三次"的根治）', () => {
        const h = makeGate();
        const request = h.gate.request({
            questions: [
                {
                    id: 'env',
                    question: '环境变量口径怎么定？',
                    options: [{ value: 'keep', label: 'B. 全套 DIY2_* 前缀' }],
                },
                {
                    id: 'topo',
                    question: 'dev 的进程拓扑怎么改？',
                    options: [{ value: 'single', label: 'A. 单端口' }],
                },
                { id: 'scope', question: '本轮落地到哪一步？', kind: 'text' },
            ],
        });

        // 一批就是一次 request / 一张卡：题数与 id 都保留（回答按 id 回传）
        expect(request.questions.map((question) => question.id)).toEqual(['env', 'topo', 'scope']);
        expect(h.gate.pendingCount()).toBe(1);

        const answer = {
            answers: [
                { id: 'env', values: ['keep'] },
                { id: 'topo', values: ['single'] },
                { id: 'scope', text: '全量' },
            ],
        };
        expect(h.gate.answer(request.askId, answer)).toEqual({ ok: true });
        expect(h.settled).toHaveLength(1);
        expect(h.settled[0]?.result.answer).toEqual(answer);
        expect(h.gate.pendingCount()).toBe(0);
    });

    it('少答一题：拒掉整批（bad-answer），卡片还在等 —— 不能收下残缺的一份', () => {
        const h = makeGate();
        const request = h.gate.request({
            questions: [
                { id: 'a', question: 'A？', options: [{ value: 'x', label: 'X' }] },
                { id: 'b', question: 'B？', options: [{ value: 'y', label: 'Y' }] },
            ],
        });

        expect(h.gate.answer(request.askId, { answers: [{ id: 'a', values: ['x'] }] })).toEqual({
            ok: false,
            code: 'bad-answer',
            reason: '还有 1 题没作答：b',
        });
        // 整批被拒：这一问仍然挂着，不是半答半丢
        expect(h.gate.pendingCount()).toBe(1);
        expect(h.settled).toEqual([]);
        // 补上就能过
        expect(
            h.gate.answer(request.askId, {
                answers: [
                    { id: 'a', values: ['x'] },
                    { id: 'b', values: ['y'] },
                ],
            }),
        ).toEqual({ ok: true });
    });

    it('题 id 对不上（客户端缓存了旧题集）：也是 bad-answer，不是"已失效"', () => {
        const h = makeGate();
        const request = h.gate.request({ questions: [{ id: 'a', question: 'A？' }] });
        expect(h.gate.answer(request.askId, { answers: [{ id: 'old', values: ['x'] }] })).toEqual({
            ok: false,
            code: 'bad-answer',
            reason: '还有 1 题没作答：a',
        });
        expect(h.gate.pendingCount()).toBe(1);
    });

    it('一题都没给：不推卡片（不造空卡片），工具拿到的是没问成', () => {
        const h = makeGate();
        expect(h.gate.request({ questions: [{ question: '   ' }] })).toBeUndefined();
        expect(h.gate.pendingCount()).toBe(0);
        expect(h.requests).toEqual([]);
    });

    it('旧快照（一批问题之前落库的单问题卡片）：归一回 questions[]，刷新后还渲得出来', async () => {
        const { normalizeAskRequest } = await import('../src/ask');
        const legacy = {
            askId: 'ask-old',
            question: '先做哪个？',
            kind: 'choice',
            options: [{ value: 'a', label: 'A' }],
            note: '背景',
            at: 1,
        };
        expect(normalizeAskRequest(legacy)).toEqual({
            askId: 'ask-old',
            questions: [
                {
                    id: 'q1',
                    question: '先做哪个？',
                    kind: 'choice',
                    options: [{ value: 'a', label: 'A' }],
                    note: '背景',
                },
            ],
            note: '背景',
            at: 1,
        });
        // 认不出来的丢掉，不造空卡片
        expect(normalizeAskRequest({ askId: 'x' })).toBeUndefined();
        expect(normalizeAskRequest(null)).toBeUndefined();
    });

    it('list() 返回挂起中的请求（刷新后恢复卡片用）', () => {
        const h = makeGate();
        h.gate.request({ question: 'Q1', options: [{ value: 'a', label: 'A' }] });
        expect(h.gate.list().map((request) => request.questions[0]?.question)).toEqual(['Q1']);
    });
});

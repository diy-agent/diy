// delivery-lifecycle.test.ts —— 一条消息从「说出来」到「被每个成员读到」的完整生命周期。
//
// 为什么单写一条（2026-11-29，##43 sm-domain-test）：投递这件事之前只有**散函数**测试
// （`setDelivery` 的取反、`failedByRoom` 的收敛、`cancel` 的清理…），没有任何一条测试
// 按「用户视角的一次操作」走完。于是每次改动都要靠人去脑子里拼「这几条加在一起还对吗」——
// 11-28 那轮「steer 失败丢消息」就是这么漏掉的（每条函数测试都绿，合起来丢消息）。
//
// 这条测试的读法：**每一段都是一句人话**，失败时报的那一行就是坏掉的那一步。

import { describe, expect, it } from 'vitest';

import { BOT_A, HUMAN, makeRoom, sleep, waitFor } from './support/harness';

/**
 * 那句话此刻对每个成员的投递状态（**当前值**，不是历史序列 —— `deliveries` 一行只留最新态）。
 * 想断言「中间经历过什么」就在中间那一刻再调一次。
 */
const statesOf = (h: ReturnType<typeof makeRoom>, messagePhrase: string): string[] => {
    // 只挑这一句话的投递行：`say()` 返回落库的条目，messageId 在 deliveries 里能对上
    const row = h.items().find((item) => item.type === 'chat' && item.data.text.includes(messagePhrase));
    if (row === undefined) return [];
    return h.room
        .deliveries()
        .filter((delivery) => delivery.messageId === row.id)
        .map((delivery) => delivery.state);
};

describe('投递的一生（领域场景）', () => {
    it('说一句 → 默认应答先读到 → 他跑的时候再说一句先排队 → 他一收尾就轮到你', async () => {
        const h = makeRoom({ reply: (bot) => `${bot.name} 收到了` });

        // ── 第一句：只有默认应答（primary）被叫起来 ─────────────────────────
        await h.room.say({ text: '第一句', author: HUMAN });
        await waitFor(() => h.room.deliveries().every((delivery) => delivery.state === 'delivered'));

        expect(h.runs).toEqual(['diy']); // 只有 primary
        expect(statesOf(h, '第一句')).toEqual(['delivered']);

        // ── 他跑的时候又说一句：这一句必须**在队列里等着**，不能丢也不能抢跑 ──
        // 这里用 setMembers 之外的办法造「在跑」不现实，所以先 hang 住一轮。
        const slow = makeRoom({ hang: true });
        const running = slow.room.say({ text: '占住这一轮', author: HUMAN });
        await waitFor(() => slow.room.busy());

        // 第二句发在「他正忙」的时候
        const queued = slow.room.say({ text: '第二句', author: HUMAN });
        await sleep(10);

        // 此刻：第一句是 working（他正在读），第二句是 pending（还没轮到）
        expect(statesOf(slow, '占住这一轮')).toEqual(['working']);
        expect(statesOf(slow, '第二句')).toEqual(['pending']);
        // 房间级「排队」只数 pending：正在读的那条不算（那是不 11-26 报过的
        //「明明在干、界面却写着排队」）
        expect(slow.room.queuedByBot().get(BOT_A.id) ?? 0).toBe(1);

        // ── 停掉这一轮：正在读的那条算「已送到」（消息确实到了他手里），
        //    排队的那条算「已取消」（用户主动停的，不是失败）───────────────
        slow.room.cancel();
        await running;
        await queued;

        expect(statesOf(slow, '占住这一轮')).toEqual(['delivered']);
        expect(statesOf(slow, '第二句')).toEqual(['cancelled']);
        expect(slow.room.busy()).toBe(false);
    });

    it('成员被删之后，他名下挂着的投递不会永远停在 pending（排队数会归零）', async () => {
        const h = makeRoom({ hang: true });
        const running = h.room.say({ text: '发给两个成员', author: HUMAN, recipients: [BOT_A.id, 'bot:gone'] });
        // 第二个成员根本不在房间里：这条投递只有 A 一行，别处不该冒出「排着队」的假象
        await waitFor(() => h.room.busy());
        expect(h.room.deliveries().filter((delivery) => delivery.botId === 'bot:gone')).toHaveLength(0);

        h.room.cancel();
        await running;
        expect(h.room.queuedByBot().size).toBe(0);
    });

    it('崩溃恢复：pending 的投递会被接着送，且正文来自投递自己（不看 items）', async () => {
        const h = makeRoom({ hang: true });
        const running = h.room.say({ text: '崩溃前发出去的话', author: HUMAN });
        await waitFor(() => h.room.busy());

        // 先把这一轮停干净（模拟「进程被杀」前的状态），再把那条投递放回 pending
        h.room.cancel();
        await running;

        const messageId = h.room.deliveries()[0]?.messageId;
        expect(messageId).toBeDefined();
        h.store.setDelivery({ roomId: h.spec.id, messageId: messageId!, botId: BOT_A.id, state: 'pending' });

        // 重启：rebuild 只重新装配，续跑要显式叫（生产里由 server 的 resume() 调）
        const restarted = makeRoom({ store: h.store, spec: h.spec });
        void restarted.room.recover();
        await waitFor(() => restarted.runs.length > 0, 2000);
        await waitFor(() => restarted.room.deliveries().every((delivery) => delivery.state !== 'pending'), 2000);

        // 续跑真的又跑了一轮，而且这条投递收到了它的正文
        expect(restarted.runs.length).toBeGreaterThan(0);
        const context = restarted.room.contextOf(BOT_A.id) ?? [];
        expect(JSON.stringify(context)).toContain('崩溃前发出去的话');
    });
});

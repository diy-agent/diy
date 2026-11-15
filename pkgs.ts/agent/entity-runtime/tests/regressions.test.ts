// regressions.test.ts —— P0 三条的回归（PR 合并门槛）。
//
// A. 重启后上下文不重复（公共日志回放要看水位）
// B. @ 点名时结论只进被点名者一次
// C. 房间换模型对已经建好的 session 生效

import { describe, expect, it } from 'vitest';

import { BOT_A, BOT_B, HUMAN, makeRoom, waitFor } from './support/harness';

/** 上下文里某段文字出现了几次 */
function countIn(context: unknown, needle: string): number {
    return JSON.stringify(context).split(needle).length - 1;
}

describe('P0 回归', () => {
    it('A. 重启重建 RoomActor 后，上下文长度不变、用户原话只出现一次', async () => {
        const h = makeRoom({ reply: () => '收到' });
        await h.room.say({ text: '记住暗号 42', author: HUMAN });

        const before = h.room.contextOf(BOT_A.id) ?? [];
        expect(countIn(before, '记住暗号 42')).toBe(1);

        // 重启：同一份 sqlite，重新装配房间（会走 loadSession + 日志回放）
        const restarted = h.rebuild();
        const after = restarted.room.contextOf(BOT_A.id) ?? [];

        expect(after).toHaveLength(before.length);
        expect(countIn(after, '记住暗号 42')).toBe(1);
    });

    it('A-old. 老库快照没有水位（log_seq = 0）时，重启也不重复', async () => {
        const h = makeRoom({ reply: () => '收到' });
        await h.room.say({ text: '记住暗号 43', author: HUMAN });
        const before = h.room.contextOf(BOT_A.id) ?? [];

        // 模拟升级前的老行：log_seq 是列默认值 0（不是真水位）
        const snapshot = h.store.loadSession(h.spec.id, BOT_A.id)!;
        h.store.saveSession(h.spec.id, BOT_A.id, { ...snapshot, logSeq: 0 });

        const restarted = h.rebuild();
        const after = restarted.room.contextOf(BOT_A.id) ?? [];
        expect(after).toHaveLength(before.length);
        expect(countIn(after, '记住暗号 43')).toBe(1);
    });

    it('B. @ 点名的结论只进被点名者一次', async () => {
        const h = makeRoom({
            reply: (bot) => (bot.id === BOT_A.id ? '我说完了 @cops 你接着' : '收到'),
        });
        await h.room.say({ text: '你先说', author: HUMAN });
        // A 的结论 @ 了 cops ⇒ cops 被唤醒并跑一轮
        await waitFor(() => h.runs.includes('cops'));
        await waitFor(() => !h.room.busy());

        const context = h.room.contextOf(BOT_B.id) ?? [];
        expect(countIn(context, '我说完了 @cops 你接着')).toBe(1);
    });

    it('C. 房间换模型后，已经建好的 session 用新模型跑下一轮', async () => {
        const h = makeRoom({ reply: () => 'ok' });
        await h.room.say({ text: '第一轮', author: HUMAN });
        expect(h.models.at(-1)).toBe('m-room');

        h.room.update({ modelKey: 'm-new' });
        await h.room.say({ text: '第二轮', author: HUMAN });
        expect(h.models.at(-1)).toBe('m-new');

        // 换模型也要落库：重建后的 session 仍然是新模型
        const restarted = h.rebuild();
        await restarted.room.say({ text: '第三轮', author: HUMAN });
        expect(restarted.models.at(-1)).toBe('m-new');
    });

    it('A+cancel：崩溃恢复重投时，原话不会再被追加一遍', async () => {
        const h = makeRoom({ hang: true });
        void h.room.say({ text: '挂着别动', author: HUMAN });
        await waitFor(() => h.room.busy());
        h.room.cancel({ keepQueue: false });
        await waitFor(() => !h.room.busy());

        // 让投递回到"没送达"的现场，再模拟重启恢复
        const messageId = h.room.deliveries()[0]?.messageId;
        expect(messageId).toBeDefined();
        h.store.setDelivery({ roomId: h.spec.id, messageId: messageId!, botId: BOT_A.id, state: 'delivering' });

        const restarted = h.rebuild();
        await waitFor(() => !restarted.room.busy());
        const context = restarted.room.contextOf(BOT_A.id) ?? [];
        expect(countIn(context, '挂着别动')).toBe(1);
    });
});

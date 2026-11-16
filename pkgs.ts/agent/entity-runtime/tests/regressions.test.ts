// regressions.test.ts —— P0 三条的回归（PR 合并门槛）。
//
// A. 重启后上下文不重复（公共日志回放要看水位）
// B. @ 点名时结论只进被点名者一次
// C. 房间换模型对已经建好的 session 生效

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import type { AgentEvent } from '../src/types';
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

describe('D/E. ask 不阻塞 / 回答另起一轮 / 改名同步', () => {
    type ExecutableTool = { execute?: (input: unknown, options: unknown) => unknown };

    /**
     * 第一轮：调 ask（应当立刻返回，本轮正常结束）；之后各轮：普通回复。
     * 用 calls 计数而不用 harness 的 runs：同一函数会被反复调用。
     */
    function askOnceThenReply(): (input: RunOptions) => AsyncIterable<AgentEvent> {
        let calls = 0;
        return async function* (input: RunOptions): AsyncIterable<AgentEvent> {
            calls += 1;
            const turnId = input.turnId ?? 'turn';
            const messageId = `msg-${calls}`;
            yield { seq: 1, type: 'run.started', turnId, messageId };
            if (calls === 1) {
                yield { seq: 2, type: 'text.delta', messageId, delta: '先问你一下' };
                yield { seq: 3, type: 'tool.started', turnId, toolCallId: 'call-ask', name: 'ask', args: {} };
                const tools = input.tools as Record<string, ExecutableTool> | undefined;
                const out = await tools?.['ask']?.execute?.(
                    { question: '选哪个？', kind: 'choice', options: [{ value: 'a', label: 'A' }] },
                    { toolCallId: 'call-ask', messages: [] },
                );
                // 回执必须立刻回来（不是等到用户作答）
                yield { seq: 4, type: 'tool.completed', turnId, toolCallId: 'call-ask', name: 'ask', result: out };
                yield { seq: 5, type: 'text.delta', messageId, delta: `（${String(out)}）` };
            } else {
                // 后续各轮也要真的产出文本：D3 数的是"插话后有没有新的回复条"，
                // 而 projector 只在有内容时才落 chat 条目（懒创建）
                yield { seq: 5, type: 'text.delta', messageId, delta: '聊点别的也行' };
            }
            // 收尾事实：真 agent 一定给（没它这一轮会被判 unknown，按失败处理）
            yield {
                seq: 6,
                type: 'run.finished',
                turnId,
                finishReason: 'stop',
                steps: 1,
                maxOutputTokens: input.maxOutputTokens ?? 0,
            };
            yield { seq: 7, type: 'message.completed', messageId };
            yield { seq: 8, type: 'run.completed', turnId };
        };
    }

    it('D. ask 不占住这一轮：工具立即返回，本轮跑完，卡片留着等回答', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });

        // 关键：用户没回答，这一轮也得自己结束（否则界面一直"正在说话"、插不进话）
        await waitFor(() => !h.room.busy());
        expect(h.room.pendingAsks()).toBe(1);

        // 模型拿到了回执（不是「未回答」），并且这一轮有完整回复
        const said = h.items().filter((item) => item.type === 'chat' && item.author?.role === 'bot');
        expect(said.some((item) => item.status === 'done')).toBe(true);
        const tool = h.items().find((item) => item.type === 'tool');
        expect(tool).toBeDefined();
        expect(tool?.status).toBe('done');
    });

    it('D2. 用户之后作答：回答变成一条用户消息，模型在新一轮里读到它', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);

        const askId = h.room.pendingAskRequests()[0]!.askId;
        expect(h.room.answerAsk(askId, { values: ['a'], text: '就 A' })).toBe(true);

        // 房间空闲 → 回答开新的一轮；等它跑完
        await waitFor(() => h.room.pendingAsks() === 0);
        await waitFor(() => !h.room.busy());

        // 1) 时间线上看得到这条回答（用户自己的消息，刷新不丢）
        const answered = h
            .items()
            .filter((item) => item.type === 'chat' && item.author?.role === 'human')
            .filter((item) => item.type === 'chat' && item.data.text.includes('回答提问'));
        expect(answered).toHaveLength(1);

        // 2) 模型在下一轮的上下文里能对上「哪一问 + 答了什么」
        const context = h.room.contextOf(BOT_A.id) ?? [];
        expect(countIn(context, '回答提问「选哪个？」')).toBe(1);
        expect(countIn(context, '就 A')).toBe(1);
        expect(countIn(context, 'A（a）')).toBe(1);
    });

    it('D3. 提问挂在界面上时，用户还能接着说别的（这就是不阻塞的意义）', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());

        // 卡片挂着，但房间空闲 → 插话能正常开一轮。say 的 promise 在这一轮跑完后才 resolve。
        const repliesBefore = h.items().filter((item) => item.type === 'chat' && item.author?.role === 'bot').length;
        await h.room.say({ text: '先聊点别的', author: HUMAN });
        const repliesAfter = h.items().filter((item) => item.type === 'chat' && item.author?.role === 'bot').length;
        expect(repliesAfter).toBeGreaterThan(repliesBefore);

        // 没被回答的提问依旧在，不会因为插话被默默废掉
        expect(h.room.pendingAsks()).toBe(1);
        expect(h.room.pendingAskRequests()[0]?.question).toBe('选哪个？');
    });

    it('E. 改名后 bot 跟着改：新结论署名新名，session 里的自称也换掉', async () => {
        const h = makeRoom({ reply: () => '收到' });
        h.room.update({ name: '改过的名字' });
        expect(h.store.listBots().find((bot) => bot.id === BOT_A.id)?.name).toBe('改过的名字');

        await h.room.say({ text: '说一句', author: HUMAN });
        // 1) 结论条目的署名
        const conclusion = h.store
            .roomEntries(h.spec.id)
            .filter((entry) => entry.kind === 'conclusion')
            .at(-1);
        expect(conclusion?.name).toBe('改过的名字');
        // 2) session 自己的 bot 快照（下一轮 system prompt / item 作者名用它）
        const said = h
            .items()
            .filter((item) => item.type === 'chat' && item.author?.id === BOT_A.id)
            .at(-1);
        expect(said?.author?.name).toBe('改过的名字');
    });
});

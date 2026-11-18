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

    it('D5. 提问带着自己的 turnId：不在界面上靠搜工具行才知道属于哪一轮', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);

        const tool = h.items().find((item) => item.type === 'tool');
        const request = h.room.pendingAskRequests()[0]!;
        expect(tool).toBeDefined();
        // 盖的必须是**那张工具行所在**的轮（而不是“最近一次分配的轮”之类的近似）
        expect(request.turnId).toBe(tool?.turnId);

        // 回答之后卡片仍在（只读），turnId 也得跟着走 —— 它那时才是真的没工具行可搜了
        h.room.answerAsk(request.askId, { values: ['a'] });
        await waitFor(() => !h.room.busy());
        expect(h.room.answeredAskRequests()[0]?.request.turnId).toBe(tool?.turnId);
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

    it('D4. 提问的成员已经不在房间：回答退给还在的成员，而不是静默丢掉', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());

        // A 的身份没了（bot 被删），但 spec 里还留着成员位：路由会把 A 过滤掉
        h.store.deleteBot(BOT_A.id);
        const askId = h.room.pendingAskRequests()[0]!.askId;
        expect(h.room.answerAsk(askId, { values: ['a'] })).toBe(true);

        // 回答得有人收：落库成用户消息 + 真有投递对象（否则用户以为模型没收到）
        const isAnswer = (item: { type: string; author?: { role?: string }; data: { text?: string } }): boolean =>
            item.type === 'chat' && item.author?.role === 'human' && (item.data.text ?? '').includes('回答提问');
        await waitFor(() => h.items().some((item) => isAnswer(item)));
        const answered = h.items().find((item) => isAnswer(item));
        const delivery = h.room.deliveries().find((entry) => entry.messageId === answered?.id);
        expect(delivery?.botId).toBe(BOT_B.id);
        await waitFor(() => !h.room.busy());
    });

    /**
     * 第一轮：连问 times 次（同一成员），并让 ask 真的走闸门；之后各轮：普通回复。
     * 21 次就会撑出上限，用来演「被新提问挤掉」那条路径。
     */
    function askManyThenReply(times: number): (input: RunOptions) => AsyncIterable<AgentEvent> {
        let calls = 0;
        return async function* (input: RunOptions): AsyncIterable<AgentEvent> {
            calls += 1;
            const turnId = input.turnId ?? 'turn';
            const messageId = `msg-${calls}`;
            yield { seq: 1, type: 'run.started', turnId, messageId };
            if (calls === 1) {
                const tools = input.tools as Record<string, ExecutableTool> | undefined;
                for (let index = 0; index < times; index += 1) {
                    const toolCallId = `call-${index}`;
                    yield { seq: index * 2 + 2, type: 'tool.started', turnId, toolCallId, name: 'ask', args: {} };
                    const out = await tools?.['ask']?.execute?.(
                        { question: `Q${index}`, kind: 'choice', options: [{ value: 'a', label: 'A' }] },
                        { toolCallId, messages: [] },
                    );
                    yield { seq: index * 2 + 3, type: 'tool.completed', turnId, toolCallId, name: 'ask', result: out };
                }
            }
            yield {
                seq: 900,
                type: 'run.finished',
                turnId,
                finishReason: 'stop',
                steps: 1,
                maxOutputTokens: input.maxOutputTokens ?? 0,
            };
            yield { seq: 901, type: 'message.completed', messageId };
            yield { seq: 902, type: 'run.completed', turnId };
        } as (input: RunOptions) => AsyncIterable<AgentEvent>;
    }

    it('D6. 被新提问挤掉：提问的成员收到系统通知（不能静默作废）', async () => {
        // 全 async 之后模型能连着问，撑到上限时最旧那条会被淘汰。
        // 淘汰对用户是可见的（卡片变成「已失效」），对**模型**却是命门：ask 不阻塞、
        // 没有 tool call 能回填，不通知它就永远停在「我问了、等回答」。
        const h = makeRoom({ cwd: '/tmp', run: askManyThenReply(21) });
        void h.room.say({ text: '一口气问完', author: HUMAN });

        await waitFor(() => h.room.pendingAsks() === 20);
        // 通知是一条消息（投出去才会进对方的上下文）—— 等它落库
        const isNotice = (item: { type: string; author?: { role?: string } }): boolean =>
            item.type === 'chat' && item.author?.role === 'system';
        await waitFor(() => h.items().some((item) => isNotice(item)));

        const notice = h.items().find((item) => isNotice(item));
        // 说的是哪一问：模型得对得上自己问的那条
        expect(notice?.data.text).toContain('Q0');
        expect(notice?.data.text).toContain('已经作废');

        // 通知 ≠ 叫醒：不进投递队列。走普通 say 会把空闲成员**真的拉起一轮**，
        // 只为读一句「不用再等」（费钱 + 多一条无意义回复，还可能让它再提问）。
        expect(h.room.deliveries().find((entry) => entry.messageId === notice?.id)).toBeUndefined();
        // 但要进上下文：模型下次真正被叫起来时得看到「那问作废了」
        expect(JSON.stringify(h.room.contextOf(BOT_A.id) ?? [])).toContain('已经作废');

        // 新的那几张照旧挂着（淘汰最旧、不是丢最新）
        expect(h.room.pendingAskRequests().some((request) => request.question === 'Q20')).toBe(true);
    });

    it('D7. 撤回一问：卡片失效、计数减一，且不触发任何运行', async () => {
        // 「取消本轮」曾经被当成这个用途，但它停的是「正在生成」—— ask 不阻塞，
        // 点它时那一轮早就跑完了，服务器对单条提问也没有撤回能力，于是什么都不发生。
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());
        const runsBefore = h.runs.length;

        const askId = h.room.pendingAskRequests()[0]!.askId;
        expect(h.room.cancelAsk(askId)).toBe(true);

        // 1) 计数减一（待办列表里不能留一条永远做不完的）
        expect(h.room.pendingAsks()).toBe(0);
        // 2) 卡片有结局（UI 显示「已失效：提问已被撤回」），而不是凭空消失
        const settled = h.events.filter((event) => event.kind === 'ask.answered');
        expect(settled.some((event) => event.kind === 'ask.answered' && event.cancelled === true)).toBe(true);
        expect(settled.some((event) => event.kind === 'ask.answered' && event.reason === '提问已被撤回')).toBe(true);
        // 3) 什么都没多跑一轮：撤回不是「取消本轮」也不是「叫醒成员」
        expect(h.runs.length).toBe(runsBefore);
        // 4) 模型仍会知道（进上下文、不触发运行），否则它永远停在「我问了、等回答」
        expect(JSON.stringify(h.room.contextOf(BOT_A.id) ?? [])).toContain('提问已被撤回');
        // 5) 撤回过的不能再答
        expect(h.room.answerAsk(askId, { values: ['a'] })).toBe(false);
    });

    it('D8. 跨成员淘汰：被挤掉的那位空闲时不会被叫起来跑一轮', async () => {
        // B 先问一个→空闲；A 随后连问 21 个，把 B 那条挤出上限。
        // 通知必须只进 B 的上下文，不能把它拉起一轮（实测旧实现多出 bot:b#2）。
        const runs: string[] = [];
        const seen = new Map<string, number>();
        const script = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
            const count = (seen.get(input.bot.id) ?? 0) + 1;
            seen.set(input.bot.id, count);
            runs.push(`${input.bot.id}#${count}`);
            const turnId = input.turnId ?? 'turn';
            const messageId = `msg-${runs.length}`;
            yield { seq: 1, type: 'run.started', turnId, messageId };
            const times = count === 1 ? (input.bot.id === BOT_A.id ? 21 : 1) : 0;
            if (times > 0) {
                const tools = input.tools as Record<string, ExecutableTool> | undefined;
                for (let index = 0; index < times; index += 1) {
                    const toolCallId = `call-${input.bot.id}-${index}`;
                    yield { seq: index * 2 + 2, type: 'tool.started', turnId, toolCallId, name: 'ask', args: {} };
                    const out = await tools?.['ask']?.execute?.(
                        {
                            question: `${input.bot.id}-Q${index}`,
                            kind: 'choice',
                            options: [{ value: 'a', label: 'A' }],
                        },
                        { toolCallId, messages: [] },
                    );
                    yield { seq: index * 2 + 3, type: 'tool.completed', turnId, toolCallId, name: 'ask', result: out };
                }
            }
            yield { seq: 900, type: 'run.finished', turnId, finishReason: 'stop', steps: 1, maxOutputTokens: 0 };
            yield { seq: 901, type: 'message.completed', messageId };
            yield { seq: 902, type: 'run.completed', turnId };
        } as (input: RunOptions) => AsyncIterable<AgentEvent>;

        const h = makeRoom({ cwd: '/tmp', run: script });
        // B 单独问一个，然后空闲下来
        void h.room.say({ text: '你先问', author: HUMAN, recipients: [BOT_B.id] });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());

        // A 连问 21 个，把 B 那条挤掉
        void h.room.say({ text: '我一口气问完', author: HUMAN, recipients: [BOT_A.id] });
        await waitFor(() => h.room.pendingAsks() === 20);
        await waitFor(() => h.items().some((item) => item.type === 'chat' && item.author?.role === 'system'));
        // 给潜在的「叫醒」一点时间跑出来（旧实现在这里会多出 bot:b#2）
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(runs).toEqual([`${BOT_B.id}#1`, `${BOT_A.id}#1`]);
        // B 仍被告知（进上下文），只是没被叫醒
        expect(JSON.stringify(h.room.contextOf(BOT_B.id) ?? [])).toContain('已经作废');
    });

    it('D5. 成员被移出房间：他问过、还没答的提问跟着失效（不能回答一张永远送不到的卡片）', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());

        h.room.setMembers([{ botId: BOT_B.id, primary: true }]);

        expect(h.room.pendingAsks()).toBe(0);
        // 卡片要有结局（UI 显示「已失效」），不能一直挂着等一个已经不存在的成员
        const settled = h.events.filter((event) => event.kind === 'ask.answered');
        expect(settled.some((event) => event.kind === 'ask.answered' && event.cancelled === true)).toBe(true);
        expect(h.room.answerAsk('ask-nope', { values: ['a'] })).toBe(false);
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

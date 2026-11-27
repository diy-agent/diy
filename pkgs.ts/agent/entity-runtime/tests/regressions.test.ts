// regressions.test.ts —— P0 三条的回归（PR 合并门槛）。
//
// A. 重启后上下文不重复（公共日志回放要看水位）
// B. @ 点名时结论只进被点名者一次
// C. 角色换模型对已经建好的 session 生效

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import type { AgentEvent, Item } from '../src/types';
import { BOT_A, BOT_B, HUMAN, makeRoom, sleep, waitFor } from './support/harness';

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

    it('C. 角色换模型后，已经建好的 session 用新模型跑下一轮', async () => {
        const h = makeRoom({ reply: () => 'ok' });
        await h.room.say({ text: '第一轮', author: HUMAN });
        expect(h.models.at(-1)).toBe('m-default');

        // 角色级换模型（模型真源 = 人设）：宿主改角色表后调 refreshIdentities 推给已建 session
        const role = h.store.listBotProfiles().find((item) => item.id === BOT_A.id);
        expect(role).toBeDefined();
        h.store.upsertBotProfile({ ...role!, modelKey: 'm-new' });
        h.room.refreshIdentities();
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

    // 下面两条守同一个真事故事实（2026-11-23）：用户在提问卡上答了 squash，那条回答
    // 已经落库、也进了房间，但模型上下文里从来没有它 —— 于是 bot 又输出一遍“正在等待”。
    // 两个缺陷各一条：水位写得太满（F）、重投时盲标 alreadyInContext（G）。

    it('F. 一轮正在跑时落快照（压缩）后重启：那条输入不会丢', async () => {
        let calls = 0;
        const run = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
            calls += 1;
            const turnId = input.turnId ?? 'turn';
            const messageId = `msg-${calls}`;
            yield { seq: 1, type: 'run.started', turnId, messageId };
            if (calls === 3) {
                // 第三轮挂住：让“这一轮正在跑”的状态持续到我们落完整快照
                while (!input.signal.aborted) await sleep(2);
                yield { seq: 2, type: 'run.failed', turnId, message: 'aborted' };
                return;
            }
            const text = `第 ${calls} 轮的回复`;
            yield { seq: 2, type: 'text.delta', messageId, delta: text };
            input.onStepTranscript?.([{ role: 'assistant', content: [{ type: 'text', text }] }]);
            yield { seq: 3, type: 'run.finished', turnId, finishReason: 'stop', steps: 1, maxOutputTokens: 0 };
            yield { seq: 4, type: 'message.completed', messageId };
            yield { seq: 5, type: 'run.completed', turnId };
        } as (input: RunOptions) => AsyncIterable<AgentEvent>;

        const h = makeRoom({ run });
        // 先跑两轮：上下文里至少要有两轮，压缩切点才可能落在某轮的轮首（判据要求 cut > 0，
        // 只有一轮时只能切到第一条 user ⇒ 压不动）
        await h.room.say({ text: '第零轮', author: HUMAN });
        await h.room.say({ text: '第一轮', author: HUMAN });

        // 第三轮：这句话已经进了公共日志，但这一轮还没跑完（既没入 transcript、也没跑完）
        void h.room.say({ text: '第二轮：这句话不能被吞', author: HUMAN }).catch(() => undefined);
        await waitFor(() => h.room.busy());

        // 在跑的当口压一次 ⇒ 触发落快照；旧写法会把水位推到房间末尾（含正在跑的那条）
        await h.room.compact(BOT_A.id, { keepTurns: 0 });

        const target = h.store
            .roomEntries(h.spec.id)
            .find((entry) => entry.kind === 'say' && entry.text === '第二轮：这句话不能被吞');
        expect(target).toBeDefined();
        const saved = h.store.loadSession(h.spec.id, BOT_A.id)!;
        expect(saved.logSeq).toBeLessThan(target!.seq);

        // 进程被杀（这里用重建房间等价）：第二轮仍在库里挂着“投递中”
        const restarted = h.rebuild();
        void restarted.room.recover();
        // 判据用 calls 而不是 h.runs：这里注入的是自定义 run，只有 harness 的脚本 run 才往 runs 里记
        await waitFor(() => calls >= 4);
        await waitFor(() => !restarted.room.busy());

        expect(countIn(restarted.room.contextOf(BOT_A.id) ?? [], '第二轮：这句话不能被吞')).toBe(1);
        h.room.cancel();
    });

    it('G. 老库坏水位（已越过一条其实没读过的消息）时，恢复也不丢', async () => {
        const h = makeRoom({ reply: () => '收到' });
        await h.room.say({ text: '第一句', author: HUMAN });

        // 手工造现场：消息已落库、投递还没送到，而快照水位是旧语义写的（= 房间末尾，越过了它）
        const item: Item = {
            id: 'u-legacy-1',
            seq: 2,
            order: 99,
            turn: 2,
            turnId: 'turn-legacy',
            at: Date.now(),
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text: '旧水位越过的那句话' },
        };
        h.store.appendItem(h.spec.id, item);
        h.store.appendRoomEntry(h.spec.id, {
            kind: 'say',
            seq: 2,
            at: Date.now(),
            author: HUMAN,
            text: '旧水位越过的那句话',
            messageId: item.id,
            turn: 2,
            turnId: 'turn-legacy',
        });
        h.store.setDelivery({
            roomId: h.spec.id,
            messageId: item.id,
            botId: BOT_A.id,
            state: 'delivering',
            mode: 'next-step',
            turn: 2,
            turnId: 'turn-legacy',
        });
        const snapshot = h.store.loadSession(h.spec.id, BOT_A.id)!;
        h.store.saveSession(h.spec.id, BOT_A.id, { ...snapshot, logSeq: 2 });

        const restarted = h.rebuild();
        void restarted.room.recover();
        await waitFor(() => restarted.runs.length > 0);
        await waitFor(() => !restarted.room.busy());

        expect(countIn(restarted.room.contextOf(BOT_A.id) ?? [], '旧水位越过的那句话')).toBe(1);
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
        h.room.answerAsk(request.askId, { answers: [{ id: 'q1', values: ['a'] }] });
        await waitFor(() => !h.room.busy());
        expect(h.room.answeredAskRequests()[0]?.request.turnId).toBe(tool?.turnId);
    });

    it('D6. 待答的提问落库：房间重新装配后卡片还在（重启不丢）', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        const before = h.room.pendingAskRequests()[0]!;

        // 同一份 store、新建 RoomActor：模拟进程重启
        const again = h.rebuild();
        const restored = again.room.pendingAskRequests();
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ askId: before.askId, owner: before.owner });
        expect(restored[0]?.questions).toEqual(before.questions);
        expect(again.room.pendingAsks()).toBe(1);
    });

    it('D2. 用户之后作答：回答变成一条用户消息，模型在新一轮里读到它', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);

        const askId = h.room.pendingAskRequests()[0]!.askId;
        expect(h.room.answerAsk(askId, { answers: [{ id: 'q1', values: ['a'], text: '就 A' }] })).toEqual({ ok: true });

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
        const askId = h.room.pendingAskRequests()[0]!.askId;
        await h.room.say({ text: '先聊点别的', author: HUMAN });
        const repliesAfter = h.items().filter((item) => item.type === 'chat' && item.author?.role === 'bot').length;
        expect(repliesAfter).toBeGreaterThan(repliesBefore);

        // 插话让它开了新的一轮 ⇒ 那张提问过期（寿命规则见 ask.ts 头部：到提问者开新轮为止）。
        // 2026-11-22 裁：以前这里断言「插话不会废掉提问」，但答案迟到会把它拽回一个不存在的状态
        //（答案走 say，等于又开一轮）。代价是不得不重新问一次，所以必须**点明**：
        expect(h.room.pendingAsks()).toBe(0);
        // 卡片留痕（不是无声消失），且说明是"过期"不是"作废"
        const settled = h.events.filter((event) => event.kind === 'ask.answered' && event.askId === askId);
        expect(settled[0]).toMatchObject({ cancelled: true, expired: true });
        expect(String(settled[0]?.reason)).toContain('已开启新一轮');
        // 它本人也得知道（ask 不阻塞、没有 tool call 能回填，不通知就永远停在「我问了、等回答」）
        expect(
            h.items().some(
                (item) => item.type === 'chat' && item.author?.role === 'system' && item.data.text.includes('已经过期'),
            ),
        ).toBe(true);
        // 过期的卡不能再答（否则会凭空冒出一条「回答提问」，而那一轮已经过去了）
        expect(h.room.answerAsk(askId, { answers: [{ id: 'q1', values: ['a'] }] }).ok).toBe(false);
    });

    it('D4. 提问的成员已经不在房间：回答退给还在的成员，而不是静默丢掉', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());

        // A 的身份没了（角色被删），但 spec 里还留着成员位：路由会把 A 过滤掉
        h.store.deleteBotProfile(BOT_A.id);
        const askId = h.room.pendingAskRequests()[0]!.askId;
        expect(h.room.answerAsk(askId, { answers: [{ id: 'q1', values: ['a'] }] })).toEqual({ ok: true });

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

    it('D6. 同一成员再问一次：上一张过期（每成员只有一张未结），且必须通知本人', async () => {
        // 2026-11-22 裁：每成员同时最多一张未结 —— 它自己的新提问就说明上一批决策已经不重要了。
        // 取代对用户是可见的（卡片变成「已过期」），对**模型**却是命门：ask 不阻塞、
        // 没有 tool call 能回填，不通知它就永远停在「我问了、等回答」。
        const h = makeRoom({ cwd: '/tmp', run: askManyThenReply(21) });
        void h.room.say({ text: '一口气问完', author: HUMAN });

        await waitFor(() => h.room.pendingAsks() === 1);
        // 通知是一条消息（投出去才会进对方的上下文）—— 等它落库
        const isNotice = (item: { type: string; author?: { role?: string } }): boolean =>
            item.type === 'chat' && item.author?.role === 'system';
        await waitFor(() => h.items().some((item) => isNotice(item)));

        const notices = h.items().filter(isNotice);
        // 说的是哪一问：模型得对得上自己问的那条（每次取代一张通知一次，19 = 被 Q20 挤掉的最后那张）
        expect(notices.some((item) => item.data.text.includes('Q19'))).toBe(true);
        expect(notices.every((item) => item.data.text.includes('已经过期'))).toBe(true);

        // 通知 ≠ 叫醒：不进投递队列。走普通 say 会把空闲成员**真的拉起一轮**，
        // 只为读一句「不用再等」（费钱 + 多一条无意义回复，还可能让它再提问）。
        for (const item of notices) {
            expect(h.room.deliveries().find((entry) => entry.messageId === item.id)).toBeUndefined();
        }
        // 但要进上下文：模型下次真正被叫起来时得看到「那问过期了」
        expect(JSON.stringify(h.room.contextOf(BOT_A.id) ?? [])).toContain('已经过期');

        // 只留最后一张（取代最旧、不是丢最新）
        expect(h.room.pendingAskRequests().map((request) => request.questions[0]?.question)).toEqual(['Q20']);
    });

    it('D6b. 过期的提问落库：重启后卡片还在，且说的是「已过期」不是「已失效」', async () => {
        // 过期不是"这张卡从没存在过"：用户回头要能看到"当时它问了我什么、为什么没答成"。
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        await waitFor(() => !h.room.busy());
        const askId = h.room.pendingAskRequests()[0]!.askId;

        // 插一句话让它开新一轮 → 那张提问过期
        await h.room.say({ text: '先别管那个', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 0);
        await waitFor(() => !h.room.busy());

        const restarted = h.rebuild();
        expect(restarted.room.pendingAsks()).toBe(0);
        const card = restarted.room.answeredAskRequests().find((entry) => entry.request.askId === askId);
        expect(card).toMatchObject({ cancelled: true, expired: true });
        expect(String(card?.reason)).toContain('已开启新一轮');
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
        expect(h.room.answerAsk(askId, { answers: [{ id: 'q1', values: ['a'] }] }).ok).toBe(false);
    });

    it('D7b. 提问有结局就删它那份草稿（换掉「过多久没人动」这种猜法）', async () => {
        // 半填答案 = `ask:<id>` 一条普通草稿。侧栏分别看「输入类草稿」和「待答提问」，
        // 所以这里要的是：提问一有结局，草稿立刻走；同一房间的发言框草稿不许受牵连。
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        const askId = h.room.pendingAskRequests()[0]!.askId;
        h.store.putDraft(h.spec.id, `ask:${askId}`, { selected: ['a'], fields: {}, text: '' });
        h.store.putDraft(h.spec.id, 'composer', { text: '还没发的一句' });

        expect(h.room.cancelAsk(askId)).toBe(true);

        expect(h.store.listDrafts(h.spec.id).map((draft) => draft.field)).toEqual(['composer']);
    });

    it('D7c. 答上来同样删草稿（`settleAsk` 是所有结局的唯一出口）', async () => {
        const h = makeRoom({ cwd: '/tmp', run: askOnceThenReply() });
        void h.room.say({ text: '动手吧', author: HUMAN });
        await waitFor(() => h.room.pendingAsks() === 1);
        const askId = h.room.pendingAskRequests()[0]!.askId;
        h.store.putDraft(h.spec.id, `ask:${askId}`, { selected: ['a'], fields: {}, text: '' });

        expect(h.room.answerAsk(askId, { answers: [{ id: 'q1', values: ['a'] }] }).ok).toBe(true);

        expect(h.store.listDrafts(h.spec.id)).toEqual([]);
    });

    it('D8. 跨成员不互相挤：A 连问 21 个只塌成一张，B 那张照旧挂着', async () => {
        // 以前的担心是「A 问到上限会把 B 挤出局，通知它时把它拉起一轮（旧实现多出 bot:b#2）」。
        // 每成员一张之后这条路走不通了：A 自己塌成一张，B 根本不受影响 —— 这比"通知不叫醒"
        // 更根治（多 bot 开会时，别人的提问不该被我的数量挤掉）。
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
        const bAskId = h.room.pendingAskRequests()[0]!.askId;

        // A 连问 21 个：自己塌成一张，B 那张动都不动
        void h.room.say({ text: '我一口气问完', author: HUMAN, recipients: [BOT_A.id] });
        await waitFor(() => h.room.pendingAsks() === 2);
        await waitFor(() => h.items().some((item) => item.type === 'chat' && item.author?.role === 'system'));
        // 给潜在的「叫醒」一点时间跑出来（旧实现在这里会多出 bot:b#2）
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(runs).toEqual([`${BOT_B.id}#1`, `${BOT_A.id}#1`]);
        // 两张各归各的：A 只留最后一张，B 的照旧
        expect(h.room.pendingAskRequests().map((request) => [request.owner, request.questions[0]?.question])).toEqual([
            [BOT_B.id, `${BOT_B.id}-Q0`],
            [BOT_A.id, `${BOT_A.id}-Q20`],
        ]);
        // B 那张从头到尾没被动过：过期事件里没有任何一条是它的
        //（注：过期留痕走的是房间公共日志，所以 B 的上下文里**会**读到 A 那批的通知 ——
        //  那是本房间发生的事实，安静通知只是不叫醒人，不是私聊）
        const expiredIds = h.events
            .filter((event) => event.kind === 'ask.answered' && event.expired === true)
            .map((event) => (event.kind === 'ask.answered' ? event.askId : ''));
        expect(expiredIds).not.toContain(bAskId);
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
        expect(h.room.answerAsk('ask-nope', { answers: [{ id: 'q1', values: ['a'] }] }).ok).toBe(false);
    });

    it('E. 容器改名**不再**改助手名（角色是类型级的）；角色改名才换署名', async () => {
        const h = makeRoom({ reply: () => '收到' });
        // 2026-11-24 之前：容器改名 = 专属 bot 改名（1:1）。现在一个角色服务该类型所有房间，
        // 跟着某一间房改名等于把别的房一起改了 —— 所以这两件事分开了。
        h.room.update({ data: { name: '改过的名字' } });
        expect(h.store.listBotProfiles().find((role) => role.id === BOT_A.id)?.name).toBe('diy');

        // 改角色名（角色页做的事）→ 推给已建好的 session：新结论署名新名
        h.store.upsertBotProfile({ ...h.store.listBotProfiles()[0]!, name: '架构', updatedAt: Date.now() });
        h.room.refreshIdentities();
        await h.room.say({ text: '说一句', author: HUMAN });

        const conclusion = h.store
            .roomEntries(h.spec.id)
            .filter((entry) => entry.kind === 'conclusion')
            .at(-1);
        expect(conclusion?.name).toBe('架构');
        // session 自己的 bot 快照（下一轮 system prompt / item 作者名用它）
        const said = h
            .items()
            .filter((item) => item.type === 'chat' && item.author?.id === BOT_A.id)
            .at(-1);
        expect(said?.author?.name).toBe('架构');
    });
});

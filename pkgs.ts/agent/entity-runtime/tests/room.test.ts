// room.test.ts —— 房间（RoomActor）的领域行为。
//
// 这里不碰 HTTP、不碰 SSE、不碰真模型：用内存 sqlite + 脚本化 run。
// 要锁的是「Room 这一个概念」：路由、回合、结论、投递、成员覆盖。

import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunOptions } from '../src/agent';
import type { CompactionResult, Compactor } from '../src/compaction';
import { openStore } from '../src/db';
import type { Item, Room } from '../src/types';
import { BOT_A, BOT_B, HUMAN, makeRoom, sleep, waitFor, type Harness } from './support/harness';

/** 房间里的「中断」轮级事实 */
const interruptedOf = (h: Harness): Item[] =>
    h.items().filter((item) => item.type === 'notice' && item.data.kind === 'interrupted');

/** 任务房间：`status` / `desc` 是**任务域的真列**（项目没有这两个字段） */
function taskSpec(): Room {
    return {
        id: 'task:data-1',
        type: 'task',
        name: '任务',
        data: { status: 'open' },
        members: [],
    };
}

describe('RoomActor', () => {
    it('没有 @：只有默认应答跑', async () => {
        const h = makeRoom();
        await h.room.say({ text: '一句话说说', author: HUMAN });

        expect(h.runs).toEqual(['diy']);
        expect(h.room.deliveries().map((d) => d.botId)).toEqual([BOT_A.id]);
        expect(h.room.deliveries()[0]?.state).toBe('done');
    });

    it('@名字：命中者回复，默认应答不动', async () => {
        const h = makeRoom();
        await h.room.say({ text: '@cops 看下这个设计', author: HUMAN });

        expect(h.runs).toEqual(['cops']);
        expect(h.room.deliveries().map((d) => d.botId)).toEqual([BOT_B.id]);
    });

    it('@all：全员回复（开会）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '@all 都说说', author: HUMAN });

        expect(h.runs.sort()).toEqual(['cops', 'diy']);
        expect(h.room.deliveries()).toHaveLength(2);
    });

    it('结论交叉：A 的结论进 B 的上下文，但不唤醒 B', async () => {
        const h = makeRoom({ reply: (bot) => `${bot.name} 的结论` });
        await h.room.say({ text: '你先说', author: HUMAN });

        // 只有 A 跑过
        expect(h.runs).toEqual(['diy']);
        // B 的上下文里有 A 的结论，而且是 user 角色（不是 assistant）
        const context = h.room.contextOf(BOT_B.id) ?? [];
        const text = JSON.stringify(context);
        expect(text).toContain('[diy 的结论] diy 的结论');
        expect(context.every((message) => message.role !== 'assistant')).toBe(true);
    });

    it('运行中再发消息：沿用当前 turn，时间线不乱', async () => {
        const h = makeRoom();
        const first = h.room.say({ text: '第一句', author: HUMAN });
        await sleep(2);
        const second = h.room.say({ text: '第二句', author: HUMAN });
        await Promise.all([first, second]);

        const turns = h
            .items()
            .filter((item) => item.type === 'chat' && item.author?.role === 'human')
            .map((item) => item.turn);
        expect(turns).toHaveLength(2);
        expect(new Set(turns).size).toBe(1);
    });

    it('人格按 成员 > bot 覆盖；模型恒等于 bot 自己的（2026-11-27 裁：模型真源 = 人设）', () => {
        const h = makeRoom({
            members: [
                { botId: BOT_A.id, primary: true, modelKey: 'm-member', persona: '借用视角' },
                { botId: BOT_B.id },
            ],
        });

        // 成员/房间的 modelKey 已退役：模型只认角色（bot）自己的
        expect(h.room.member(BOT_A.id)?.modelKey).toBe('m-default');
        expect(h.room.member(BOT_A.id)?.persona).toBe('借用视角');
        expect(h.room.member(BOT_B.id)?.modelKey).toBe('m-default');
        expect(h.room.member(BOT_B.id)?.persona).toBe('产品视角');
    });

    it("空的 modelKey（''）不再有继承链 —— 模型恒等于 bot 自己的", () => {
        const h = makeRoom({
            modelKey: 'm-room',
            members: [{ botId: BOT_A.id, primary: true, modelKey: '' }],
        });

        expect(h.room.member(BOT_A.id)?.modelKey).toBe('m-default');
    });

    it('cancel：在跑的会话被中止，投递仍算已送达（失败体现在 bot 的回复上）', async () => {
        const h = makeRoom({ hang: true });
        const running = h.room.say({ text: '会被取消', author: HUMAN });
        await sleep(3);
        h.room.cancel();
        await running;

        expect(h.room.busy()).toBe(false);
        // 消息确实送到了 bot 手里；被取消的是"它的回复"，不是投递
        expect(h.room.deliveries()[0]?.state).toBe('done');
    });

    it('显式 recipients = 开会：不解析 @', async () => {
        const h = makeRoom();
        await h.room.say({ text: '没有 at 的一段话', author: HUMAN, recipients: [BOT_A.id, BOT_B.id] });

        expect(h.runs.sort()).toEqual(['cops', 'diy']);
    });

    it('重启：公共日志、会话上下文都能恢复', async () => {
        const first = makeRoom();
        await first.room.say({ text: '先讨论一轮', author: HUMAN });
        const entries = first.room.entries().length;

        // 同一个库，新建一个 actor = 模拟重启
        const second = makeRoom({ store: first.store });
        expect(second.room.entries()).toHaveLength(entries);
        expect(second.runs).toEqual([]); // 恢复本身不该触发运行
        // 上下文也回来了（含自己的回复和别人的结论）
        expect(JSON.stringify(second.room.contextOf(BOT_A.id) ?? [])).toContain('diy 的回复');
    });

    it('queuedByBot：排队中的投递按成员计数（queued + delivering，给 UI 画「排队中」）', () => {
        // 刀 2 的服务端那一半：以前 `deliveries` 的排队态在界面完全看不见，
        // 重启后的待续跑尤其 —— 房间看着没事，其实排着队
        const store = openStore(':memory:');
        for (const [index, bot] of [BOT_A, BOT_B].entries()) {
            store.upsertBotProfile({
                id: bot.id,
                type: 'project',
                name: bot.name,
                color: bot.color,
                instructions: bot.persona,
                primary: index === 0,
                modelKey: bot.modelKey,
                reasoningEffort: null,
                createdAt: index,
                updatedAt: index,
            });
        }
        const item = (id: string, seq: number): Item => ({
            id,
            seq,
            order: seq,
            turn: seq,
            turnId: `turn-${seq}`,
            at: Date.now(),
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text: id },
        });
        store.appendItem('room:1', item('u-1', 1));
        store.appendItem('room:1', item('u-2', 2));
        store.appendItem('room:1', item('u-3', 3));
        store.setDelivery({ roomId: 'room:1', messageId: 'u-1', botId: BOT_A.id, state: 'pending' });
        // 重启残留的 `working` 在 openStore 时已被重置成 `pending`（db.ts 的 migrateDeliveryStates）
        store.setDelivery({ roomId: 'room:1', messageId: 'u-2', botId: BOT_A.id, state: 'pending' });
        store.setDelivery({ roomId: 'room:1', messageId: 'u-3', botId: BOT_B.id, state: 'pending' });
        // 已处理完的不算排队
        store.appendItem('room:1', item('u-4', 4));
        store.setDelivery({ roomId: 'room:1', messageId: 'u-4', botId: BOT_B.id, state: 'done' });

        const h = makeRoom({ store });
        expect(Object.fromEntries(h.room.queuedByBot())).toEqual({ [BOT_A.id]: 2, [BOT_B.id]: 1 });

        // 跑完一条就少一条（UI 的灰旋转跟着灭）
        store.setDelivery({ roomId: 'room:1', messageId: 'u-1', botId: BOT_A.id, state: 'done' });
        expect(Object.fromEntries(h.room.queuedByBot())).toEqual({ [BOT_A.id]: 1, [BOT_B.id]: 1 });
    });

    it('正在跑的那条 working 不算排队（“在跑”不该被写成“排队中”）', async () => {
        // 用户 2026-11-26 报的表里一行：状态写「排队中」、结局写「中断（上一轮没跑完）」。
        // 原因：该 bot 正在跑（投递 = delivering），而 `queuedByBot` 把 delivering 也算排队。
        // 2026-11-27 状态收成 3 个后结构上不可能：`working` 就是不数。
        const h = makeRoom({ hang: true });
        void h.room.say({ text: '跑着', author: HUMAN });
        await waitFor(() => h.room.runningBots().length > 0);
        const runner = h.room.runningBots()[0];
        expect(runner).toBeDefined();
        expect(h.room.queuedByBot().get(runner!) ?? 0).toBe(0);
        h.room.cancel();
    });

    it('崩溃恢复：未送达的投递重新投一遍', async () => {
        const store = openStore(':memory:');
        for (const [index, bot] of [BOT_A, BOT_B].entries()) {
            store.upsertBotProfile({
                id: bot.id,
                type: 'project',
                name: bot.name,
                color: bot.color,
                instructions: bot.persona,
                primary: index === 0,
                modelKey: bot.modelKey,
                reasoningEffort: null,
                createdAt: index,
                updatedAt: index,
            });
        }
        const userItem: Item = {
            id: 'u-crash-1',
            seq: 1,
            order: 1,
            turn: 1,
            turnId: 'turn-crash',
            at: Date.now(),
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text: '崩溃前发出去、还没送达的消息' },
        };
        store.appendItem('room:1', userItem);
        store.setDelivery({
            roomId: 'room:1',
            messageId: userItem.id,
            botId: BOT_A.id,
            state: 'pending',
            mode: 'human',
            turn: 1,
            turnId: 'turn-crash',
        });

        const h = makeRoom({ store });
        expect(h.runs).toEqual([]);
        void h.room.recover();
        await waitFor(() => h.room.deliveries()[0]?.state === 'done');
        expect(h.runs).toEqual(['diy']);
    });

    it('崩溃恢复是**串行**的：前一条跑到收尾，后一条才开始（不一起冲网关）', async () => {
        // 判据只能靠「第一个卡着时第二个有没有开始」：一起排出去的话，第二轮的 run
        // 会在第一个还没收尾时就 push 进 started，这一条就红了（2026-11-25 的那次一屏 429）。
        const store = openStore(':memory:');
        for (const [index, bot] of [BOT_A, BOT_B].entries()) {
            store.upsertBotProfile({
                id: bot.id,
                type: 'project',
                name: bot.name,
                color: bot.color,
                instructions: bot.persona,
                primary: index === 0,
                modelKey: bot.modelKey,
                reasoningEffort: null,
                createdAt: index,
                updatedAt: index,
            });
        }
        const item = (id: string, seq: number, text: string): Item => ({
            id,
            seq,
            order: seq,
            turn: seq,
            turnId: `turn-${seq}`,
            at: Date.now(),
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text },
        });
        store.appendItem('room:1', item('u-1', 1, '第一句'));
        store.appendItem('room:1', item('u-2', 2, '第二句'));
        store.setDelivery({
            roomId: 'room:1',
            messageId: 'u-1',
            botId: BOT_A.id,
            state: 'pending',
            turn: 1,
            turnId: 'turn-1',
        });
        store.setDelivery({
            roomId: 'room:1',
            messageId: 'u-2',
            botId: BOT_B.id,
            state: 'pending',
            turn: 2,
            turnId: 'turn-2',
        });

        const started: string[] = [];
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
            started.push(input.bot.name);
            const turnId = input.turnId ?? 'turn';
            const messageId = `msg-${started.length}`;
            yield { seq: 1, type: 'run.started', turnId, messageId };
            // 第一轮故意卡在这里：并行的实现会把第二轮也放出去
            if (started.length === 1) await gate;
            yield { seq: 2, type: 'text.delta', messageId, delta: `${input.bot.name} 的回复` };
            yield { seq: 3, type: 'run.finished', turnId, finishReason: 'stop', steps: 1, maxOutputTokens: 0 };
            yield { seq: 4, type: 'message.completed', messageId };
            yield { seq: 5, type: 'run.completed', turnId };
        } as (input: RunOptions) => AsyncIterable<AgentEvent>;

        const h = makeRoom({ store, run });
        void h.room.recover();
        await waitFor(() => started.length === 1);
        await sleep(5);
        expect(started).toHaveLength(1); // 第一个还卡着，第二个没动

        release!();
        await waitFor(() => started.length === 2);
        expect(started).toEqual(['diy', 'cops']);
    });

    it('running 事件：谁在说话由房间广播，结束时清空', async () => {
        const h = makeRoom();
        await h.room.say({ text: '说一句', author: HUMAN });

        const running = h.events
            .filter((event) => event.kind === 'running')
            .map((event) => (event as { botIds: string[] }).botIds);
        expect(running[0]).toEqual([BOT_A.id]);
        expect(running.at(-1)).toEqual([]);
    });

    it('turn.end 事件：把「这一轮为什么结束」广播给客户端（页脚用它）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '说一句', author: HUMAN });

        const ends = h.events.filter((event) => event.kind === 'turn.end');
        expect(ends).toHaveLength(1);
        const end = ends[0] as { botId: string; turnId: string; reason: { type: string } };
        expect(end.botId).toBe(BOT_A.id);
        expect(end.turnId).not.toBe('');
        expect(end.reason.type).toBe('completed');
    });

    it('turn.end 也广播"被截断"：页脚与时间线都据此说话', async () => {
        // 脚本 run 直接给 length：判据要在这里说出真话（不是"完成"）
        const h = makeRoom({
            run: async function* (input) {
                const turnId = input.turnId ?? 'turn';
                yield { seq: 1, type: 'run.started', turnId, messageId: 'msg-1' };
                yield { seq: 2, type: 'text.delta', messageId: 'msg-1', delta: '半句话' };
                yield {
                    seq: 3,
                    type: 'run.finished',
                    turnId,
                    finishReason: 'length',
                    steps: 1,
                    maxOutputTokens: 8192,
                };
                yield { seq: 4, type: 'message.completed', messageId: 'msg-1' };
                yield { seq: 5, type: 'run.completed', turnId };
            },
        });
        await h.room.say({ text: '写长一点', author: HUMAN });

        const end = h.events.find((event) => event.kind === 'turn.end') as
            | { reason: { type: string; maxOutputTokens?: number } }
            | undefined;
        expect(end?.reason.type).toBe('max-tokens');
        expect(end?.reason.maxOutputTokens).toBe(8192);
        // 结论不公开：截断的话不能进公共日志
        expect(h.items().some((item) => item.type === 'notice')).toBe(true);
    });

    it('开轮广播开始时刻，收轮给同一对时刻（消息头与结算行不许各算一次）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '你好', author: HUMAN });

        const start = h.events.find((event) => event.kind === 'turn.start') as
            | { startedAt: number; turnId: string }
            | undefined;
        const end = h.events.find((event) => event.kind === 'turn.end') as
            | { startedAt?: number; endedAt?: number; reason: { steps?: number } }
            | undefined;
        expect(start?.startedAt).toBeTypeOf('number');
        // 同一轮：开始时刻必须是**同一个值**（不是各自 Date.now()）
        expect(end?.startedAt).toBe(start?.startedAt);
        expect(end?.endedAt).toBeGreaterThanOrEqual(start!.startedAt);
    });

    it('runningTurns 只用在跑的成员（收轮后不留残留）', async () => {
        const h = makeRoom({ hang: true });
        void h.room.say({ text: '跑一会', author: HUMAN });
        await waitFor(() => h.room.runningBots().length > 0);

        const live = h.room.runningTurns();
        expect(live.length).toBeGreaterThan(0);
        expect(live.every((row) => row.startedAt <= Date.now())).toBe(true);

        h.room.cancel();
        await waitFor(() => h.room.runningBots().length === 0);
        expect(h.room.runningTurns()).toEqual([]);
    });

    it('单会话取消：只停指定的成员，另一个继续', async () => {
        const h = makeRoom({ hang: true });
        const turn = h.room.say({ text: '@all 都说说', author: HUMAN });
        await sleep(5);
        expect(h.room.runningBots().sort()).toEqual([BOT_A.id, BOT_B.id].sort());

        h.room.cancel({ botId: BOT_A.id });
        await sleep(5);
        // A 已停，B 还在跑
        expect(h.room.runningBots()).toEqual([BOT_B.id]);

        h.room.cancel();
        await turn;
        expect(h.room.runningBots()).toEqual([]);
    });

    it('改 data：浅合并并落库（重启后任务状态 / 描述还在）', () => {
        const h = makeRoom({ spec: taskSpec() });
        h.room.update({ data: { status: 'doing', desc: '做到能跑' } });

        expect(h.room.spec.data).toMatchObject({ status: 'doing', desc: '做到能跑' });
        // 重启：status / desc 已经是 tasks 的列，拼回 Room 时同名同义
        const again = h.rebuild();
        expect(again.room.spec.data).toMatchObject({ status: 'doing', desc: '做到能跑' });
    });

    it('改 data：null = 删掉这个键（列有缺省值，重载后回到 open）', () => {
        const h = makeRoom({ spec: taskSpec() });
        h.room.update({ data: { status: 'closed' } });
        h.room.update({ data: { status: null } });
        expect('status' in h.room.spec.data).toBe(false);
        // status 是 NOT NULL 列：删键 = 回到缺省，而不是留个空
        const again = h.rebuild();
        expect(again.room.spec.data['status']).toBe('open');
    });

    it('stop：删容前把还在跑的会话停掉（不往已删的房间里写）', async () => {
        const h = makeRoom({ hang: true });
        void h.room.say({ text: '跑一会', author: HUMAN });
        await waitFor(() => h.room.runningBots().length > 0);

        h.room.stop();
        await waitFor(() => !h.room.busy());
        expect(h.room.runningBots()).toEqual([]);
    });

    it('新成员加入时回放公共日志（能读到此前结论）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '先讨论一轮', author: HUMAN });
        await sleep(0);

        // B 在第一次 say 时就建了 session 并 ingest 过，这里验证结论确实进去了
        expect(JSON.stringify(h.room.contextOf(BOT_B.id) ?? [])).toContain('[diy 的结论]');
    });

    describe('手动压缩（房间级）', () => {
        /** 挂起直到被 abort：模拟那次要好几秒的 LLM 摘要 */
        const hanging = (): Compactor => ({
            name: 'test-hang',
            compact: ({ signal }) =>
                new Promise<CompactionResult | null>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        });

        it('同一成员不许并发压两次；取消能 rescue 它，取消后不再残留', async () => {
            const h = makeRoom({ compactor: hanging() });
            const first = h.room.compact(BOT_A.id, { compactId: 'c1' });
            await waitFor(() => h.room.compactingIds().includes('c1'));

            // 并发会拿同一份旧上下文算边界，后完成的把前一次结果盖回去
            await expect(h.room.compact(BOT_A.id)).rejects.toThrow('正在压缩');

            expect(h.room.cancelCompact('c1')).toBe(true);
            const { event } = await first;
            // 取消 = 这次不压（不是「按新边界压了、只是没摘要」）
            expect(event).toBeNull();
            // 已结束 / 没这个 id：手点慢了，不是错误
            expect(h.room.cancelCompact('c1')).toBe(false);
            expect(h.room.cancelCompact('nope')).toBe(false);

            const states = h.events.filter((entry) => entry.kind === 'compact').map((entry) => entry.compact.state);
            expect(states).toEqual(['running', 'cancelled']);
            // 表里不能残留：否则这个成员从此永远「正在压缩」
            expect(h.room.compactingIds()).toEqual([]);
        });

        it('取消之后能再压（不残留 = 还能重试）', async () => {
            let calls = 0;
            const compactor: Compactor = {
                name: 'test-hang-once',
                compact: ({ signal }) => {
                    calls += 1;
                    if (calls > 1) return null;
                    return new Promise<CompactionResult | null>((_resolve, reject) => {
                        signal?.addEventListener('abort', () => reject(new Error('aborted')));
                    });
                },
            };
            const h = makeRoom({ compactor });
            const first = h.room.compact(BOT_A.id, { compactId: 'c1' });
            await waitFor(() => h.room.compactingIds().includes('c1'));
            h.room.cancelCompact('c1');
            expect((await first).event).toBeNull();

            const again = await h.room.compact(BOT_A.id);
            expect(again.event).toBeNull();
            expect(calls).toBe(2);
        });
    });
});

describe('中断的轮次', () => {
    // 「这一轮开了、还没收尾」靠 turn_open 表记：turn.start 写一行、turn.end 销掉。
    // 进程在这中间被杀，磁盘上就只剩那行标记 —— 重启时据此补一条轮级事实。
    it('跑完一轮：turn_open 不留痕', async () => {
        const h = makeRoom();
        await h.room.say({ text: '一句话', author: HUMAN });
        expect(h.store.openTurns(h.spec.id)).toEqual([]);
    });

    it('跑着的时候有标记，openTurns 能读到它', async () => {
        const h = makeRoom({ hang: true });
        void h.room.say({ text: '跑着', author: HUMAN });
        await waitFor(() => h.store.openTurns(h.spec.id).length > 0);
        const opens = h.store.openTurns(h.spec.id);
        expect(opens.map((open) => open.botId)).toEqual([BOT_A.id]);
        expect(opens[0]?.turnId).toBeTruthy();
        h.room.cancel();
    });

    it('重启时残留的开轮补一条 interrupted 事实并销标记', () => {
        const h = makeRoom();
        h.store.openTurn(h.spec.id, { botId: BOT_A.id, turn: 3, turnId: 'turn-crashed', at: 1_700_000_000_000 });
        const restarted = h.rebuild();

        const facts = restarted.items().filter((it) => it.type === 'notice' && it.data.kind === 'interrupted');
        expect(facts).toHaveLength(1);
        // 四条性质：归那一轮的 turnId / 不带 author（轮级事实）/ 归属记在 botId / 标记已销
        expect(facts[0]?.turnId).toBe('turn-crashed');
        expect(facts[0]?.author).toBeUndefined();
        expect(facts[0]?.type === 'notice' ? facts[0].data.botId : undefined).toBe(BOT_A.id);
        // at 是「发现时刻」而非轮开始时刻：order 已经把它排在末尾，时间得跟位置一致
        expect(facts[0]?.at).toBeGreaterThan(1_700_000_000_000);
        expect(restarted.store.openTurns(h.spec.id)).toEqual([]);
    });

    it('成员已不在房间：只销标记，不补事实', () => {
        const h = makeRoom();
        h.store.openTurn(h.spec.id, { botId: 'bot:gone', turn: 1, turnId: 'turn-x', at: 1 });
        const restarted = h.rebuild();

        expect(restarted.items().filter((it) => it.type === 'notice' && it.data.kind === 'interrupted')).toHaveLength(
            0,
        );
        expect(restarted.store.openTurns(h.spec.id)).toEqual([]);
    });

    it('没有残留标记时重启不写任何事实', () => {
        const h = makeRoom();
        const before = h.items().length;
        const restarted = h.rebuild();
        expect(restarted.items()).toHaveLength(before);
    });

    // 现实里最常见的那种「崩溃」其实是重启：diy2 恢复了会按原 turn 号重放还挂在
    // queued / delivering 的投递（见 RoomActor.recover），那一轮马上就续跑了。
    // 对它报「没跑完」会得到一条与自己后面内容矛盾的提示，而且因为续跑完成不产条目，
    // 这条 notice 会永远坐在「该轮最后一条轮级事实」的位置上，把 bot 永久标成中断。
    it('还挂着待重放投递的轮不算中断：不补事实、标记留给续跑收口', () => {
        const h = makeRoom();
        h.store.openTurn(h.spec.id, { botId: BOT_A.id, turn: 3, turnId: 'turn-resume', at: 1_700_000_000_000 });
        h.store.setDelivery({
            roomId: h.spec.id,
            messageId: 'msg-resume',
            botId: BOT_A.id,
            state: 'working',
            turn: 3,
            turnId: 'turn-resume',
        });
        const restarted = h.rebuild();

        expect(interruptedOf(restarted)).toHaveLength(0);
        // 标记不销：由续跑的 turn.end 销；万一续跑没成（投递变 failed）就不在 pending 里了，
        // 下次启动走正经分支 —— 真中断晚一个启动周期报，不会丢
        expect(restarted.store.openTurns(h.spec.id).map((open) => open.turnId)).toEqual(['turn-resume']);
    });

    it('续跑的轮：上次启动误报的那条被撤掉', () => {
        const h = makeRoom();
        h.store.openTurn(h.spec.id, { botId: BOT_A.id, turn: 3, turnId: 'turn-resume', at: 1_700_000_000_000 });
        h.store.appendItem(h.spec.id, {
            id: 'n-stale',
            seq: 0,
            order: 1,
            turn: 3,
            turnId: 'turn-resume',
            at: 1,
            status: 'done',
            type: 'notice',
            data: { text: '上一段进程误报的', kind: 'interrupted', botId: BOT_A.id },
        });
        h.store.setDelivery({
            roomId: h.spec.id,
            messageId: 'msg-resume',
            botId: BOT_A.id,
            state: 'working',
            turn: 3,
            turnId: 'turn-resume',
        });

        expect(interruptedOf(h.rebuild())).toHaveLength(0);
    });

    // 最隐的那一种：标记已被上一段进程销掉（所以重启时 reportOpenTurns 根本看不到它），
    // 但那条误报还在磁盘上——续跑跑到收尾时必须把它撤掉，否则结局永远是「中断」。
    it('续跑跑到收尾：上一段进程留下的中断事实被撤掉', async () => {
        const h = makeRoom();
        h.store.appendItem(h.spec.id, {
            id: 'msg-resume',
            seq: 0,
            order: 1,
            turn: 3,
            turnId: 'turn-resume',
            at: 1,
            status: 'done',
            type: 'chat',
            author: HUMAN,
            data: { text: '原话' },
        });
        h.store.appendItem(h.spec.id, {
            id: 'n-stale',
            seq: 0,
            order: 2,
            turn: 3,
            turnId: 'turn-resume',
            at: 2,
            status: 'done',
            type: 'notice',
            data: { text: '上一段进程误报的', kind: 'interrupted', botId: BOT_A.id },
        });
        h.store.setDelivery({
            roomId: h.spec.id,
            messageId: 'msg-resume',
            botId: BOT_A.id,
            state: 'working',
            turn: 3,
            turnId: 'turn-resume',
        });

        const restarted = h.rebuild();
        void restarted.room.recover();
        await waitFor(() => restarted.room.deliveries().every((d) => d.state === 'done'));

        expect(interruptedOf(restarted)).toHaveLength(0);
        expect(restarted.store.openTurns(h.spec.id)).toEqual([]);
    });

    it('真中断的轮不会因为别的轮收尾被误删', async () => {
        const h = makeRoom();
        h.store.appendItem(h.spec.id, {
            id: 'n-crashed',
            seq: 0,
            order: 1,
            turn: 3,
            turnId: 'turn-crashed',
            at: 1,
            status: 'done',
            type: 'notice',
            data: { text: '真的没跑完', kind: 'interrupted', botId: BOT_A.id },
        });

        // 下一轮正常跑完（不同 turnId）—— 上一轮的结局该留着
        await h.room.say({ text: '再跑一轮', author: HUMAN });
        expect(interruptedOf(h)).toHaveLength(1);
    });
});

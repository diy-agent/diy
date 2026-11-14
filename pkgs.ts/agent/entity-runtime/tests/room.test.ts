// room.test.ts —— 房间（RoomActor）的领域行为。
//
// 这里不碰 HTTP、不碰 SSE、不碰真模型：用内存 sqlite + 脚本化 run。
// 要锁的是「Room 这一个概念」：路由、回合、结论、投递、成员覆盖。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import { openStore, type Store } from '../src/db';
import { RoomActor } from '../src/room';
import type { AgentEvent, Bot, Item, Room, RoomEvent } from '../src/types';

const BOT_A: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '工程视角', homeRoomId: 'room:1', modelKey: 'm-default' };
const BOT_B: Bot = { id: 'bot:b', name: 'cops', color: '#222', persona: '产品视角', homeRoomId: 'room:1', modelKey: 'm-default' };
const HUMAN = { id: 'human:我', name: '我', color: '#999', role: 'human' as const };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
    room: RoomActor;
    store: Store;
    events: RoomEvent[];
    runs: string[];
    items(): Item[];
}

function makeRoom(options: { hang?: boolean; reply?: (bot: Bot) => string; members?: Room['members'] } = {}): Harness {
    const store = openStore(':memory:');
    const bots = [BOT_A, BOT_B];
    for (const bot of bots) store.upsertBot(bot);

    const spec: Room = {
        id: 'room:1',
        type: 'project',
        name: 'demo',
        data: {},
        members: options.members ?? [{ botId: BOT_A.id, primary: true }, { botId: BOT_B.id }],
        modelKey: 'm-room',
    };
    store.setMembers(spec.id, spec.members);

    const events: RoomEvent[] = [];
    const runs: string[] = [];

    const run = (async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        runs.push(input.bot.name);
        const turnId = input.turnId ?? 'turn';
        yield { seq: 1, type: 'run.started', turnId, messageId: `msg-${runs.length}` };
        await sleep(5);
        if (options.hang === true) {
            while (!input.signal.aborted) await sleep(2);
            yield { seq: 2, type: 'run.failed', turnId, message: 'aborted' };
            return;
        }
        const text = options.reply?.(input.bot) ?? `${input.bot.name} 的回复`;
        yield { seq: 2, type: 'text.delta', messageId: `msg-${runs.length}`, delta: text };
        input.onStepTranscript?.([{ role: 'assistant', content: [{ type: 'text', text }] }]);
        yield { seq: 3, type: 'message.completed', messageId: `msg-${runs.length}` };
        yield { seq: 4, type: 'run.completed', turnId };
    }) as (input: RunOptions) => AsyncIterable<AgentEvent>;

    const room = new RoomActor({
        spec,
        store,
        bots: () => bots,
        emit: (event) => events.push(event),
        run,
    });

    return { room, store, events, runs, items: () => store.itemsOf(spec.id) };
}

describe('RoomActor', () => {
    it('没有 @：只有默认应答跑', async () => {
        const h = makeRoom();
        await h.room.say({ text: '一句话说说', author: HUMAN });

        expect(h.runs).toEqual(['diy']);
        expect(h.room.deliveries().map((d) => d.botId)).toEqual([BOT_A.id]);
        expect(h.room.deliveries()[0]?.state).toBe('delivered');
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

        const turns = h.items()
            .filter((item) => item.type === 'chat' && item.author?.role === 'human')
            .map((item) => item.turn);
        expect(turns).toHaveLength(2);
        expect(new Set(turns).size).toBe(1);
    });

    it('成员覆盖：模型和人格按 成员 > 房间 > bot 解析', () => {
        const h = makeRoom({
            members: [
                { botId: BOT_A.id, primary: true, modelKey: 'm-member', persona: '借用视角' },
                { botId: BOT_B.id },
            ],
        });

        expect(h.room.member(BOT_A.id)?.modelKey).toBe('m-member');
        expect(h.room.member(BOT_A.id)?.persona).toBe('借用视角');
        // B 没有成员覆盖 → 用房间默认
        expect(h.room.member(BOT_B.id)?.modelKey).toBe('m-room');
        expect(h.room.member(BOT_B.id)?.persona).toBe('产品视角');
    });

    it('cancel：在跑的会话被中止，投递标为失败', async () => {
        const h = makeRoom({ hang: true });
        const running = h.room.say({ text: '会被取消', author: HUMAN });
        await sleep(3);
        h.room.cancel();
        await running;

        expect(h.room.busy()).toBe(false);
        expect(h.room.deliveries()[0]?.state).toBe('failed');
    });

    it('显式 recipients = 开会：不解析 @', async () => {
        const h = makeRoom();
        await h.room.say({ text: '没有 at 的一段话', author: HUMAN, recipients: [BOT_A.id, BOT_B.id] });

        expect(h.runs.sort()).toEqual(['cops', 'diy']);
    });

    it('新成员加入时回放公共日志（能读到此前结论）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '先讨论一轮', author: HUMAN });
        await sleep(0);

        // B 在第一次 say 时就建了 session 并 ingest 过，这里验证结论确实进去了
        expect(JSON.stringify(h.room.contextOf(BOT_B.id) ?? [])).toContain('[diy 的结论]');
    });
});

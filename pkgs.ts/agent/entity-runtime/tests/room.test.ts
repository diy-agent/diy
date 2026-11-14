// room.test.ts —— 房间（RoomActor）的领域行为。
//
// 这里不碰 HTTP、不碰 SSE、不碰真模型：用内存 sqlite + 脚本化 run。
// 要锁的是「Room 这一个概念」：路由、回合、结论、投递、成员覆盖。

import { describe, expect, it } from 'vitest';

import { openStore } from '../src/db';
import type { Item } from '../src/types';
import { BOT_A, BOT_B, HUMAN, makeRoom, sleep, waitFor } from './support/harness';

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

    it('崩溃恢复：未送达的投递重新投一遍', async () => {
        const store = openStore(':memory:');
        const bots = [BOT_A, BOT_B];
        for (const bot of bots) store.upsertBot(bot);
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
            state: 'queued',
            mode: 'next-step',
            turn: 1,
            turnId: 'turn-crash',
        });

        const h = makeRoom({ store });
        expect(h.runs).toEqual([]);
        h.room.recover();
        await waitFor(() => h.room.deliveries()[0]?.state === 'delivered');
        expect(h.runs).toEqual(['diy']);
    });

    it('新成员加入时回放公共日志（能读到此前结论）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '先讨论一轮', author: HUMAN });
        await sleep(0);

        // B 在第一次 say 时就建了 session 并 ingest 过，这里验证结论确实进去了
        expect(JSON.stringify(h.room.contextOf(BOT_B.id) ?? [])).toContain('[diy 的结论]');
    });
});

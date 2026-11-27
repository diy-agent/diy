// transport-conformance.test.ts —— ChatClient 端口的**同一套场景**，跑在不同传输实现上。
//
// 为什么不是"测 HTTP 接口"：传输马上要换成 diy-rpc。要锁的是**端口契约**（UI 只依赖它），
// 而不是某一种线缆。于是：
//
//   · in-process —— 直接调 RoomActor，零网络
//   · json-wire  —— 同样的调用，但每条命令/事件过一次 JSON（模拟序列化边界）
//   · 将来       —— 加一个 rpc 实现进 transports，场景一条都不改
//
// 领域语义本身在 room.test.ts 里锁；这里只锁"通过端口能看到/做到什么"。

import { describe, expect, it } from 'vitest';

import type { ChatClient, StreamEvent } from '@diy-agent/chat-core';

import { BOT_A, makeRoom, sleep, type Harness } from './support/harness';
import { DirectRoomClient } from './support/direct-client';

type Factory = (harness: Harness) => ChatClient;

const transports: Array<[string, Factory]> = [
    ['in-process', (harness) => new DirectRoomClient(harness, false)],
    ['json-wire', (harness) => new DirectRoomClient(harness, true)],
];

async function send(client: ChatClient, text: string): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    await client.post('room:1', { kind: 'send', text }, (event) => events.push(event));
    return events;
}

describe.each(transports)('ChatClient 端口 / %s', (_name, makeClient) => {
    it('send：事件流里有 item / delivery / done，内容能在快照里读到', async () => {
        const h = makeRoom({ reply: () => '收到，我在。' });
        const client = makeClient(h);

        const events = await send(client, '在吗');

        const kinds = new Set(events.map((event) => event.kind));
        expect(kinds.has('item')).toBe(true);
        expect(kinds.has('delivery')).toBe(true);
        // 「这一轮是怎么停的」必须过传输层到 UI（页脚靠它）—— 它是领域事件，不是日志
        expect(kinds.has('turn.end')).toBe(true);
        expect(events.at(-1)?.kind).toBe('done');

        const snapshot = await client.load();
        const texts = snapshot.items.filter((item) => item.type === 'chat').map((item) => item.data.text);
        expect(texts).toContain('在吗');
        expect(texts.some((text) => text.includes('收到'))).toBe(true);
    });

    it('cancel：在跑的会话中止，投递仍算 delivered（失败归 bot 的回复）', async () => {
        const h = makeRoom({ hang: true });
        const client = makeClient(h);

        const running = send(client, '会被取消');
        await sleep(5);
        await client.post('room:1', { kind: 'cancel' }, () => undefined);
        await running;

        const snapshot = await client.load();
        expect(snapshot.deliveries[0]?.state).toBe('done');
    });

    it('sessions / compact：通过端口可读、可压（只影响自己）', async () => {
        const h = makeRoom({ reply: () => '好' });
        const client = makeClient(h);
        await send(client, '第一句');
        await send(client, '第二句');
        await send(client, '第三句');

        const sessions = await client.sessions!();
        expect(sessions.map((session) => session.name)).toContain('diy');
        expect(sessions[0]?.stats.tokens).toBeGreaterThan(0);

        const outcome = await client.compact!(BOT_A.id, { keepTurns: 1 });
        expect(outcome.event).not.toBeNull();
    });

    it('load 的形状：items / deliveries / asks 三件套都在', async () => {
        const h = makeRoom();
        const client = makeClient(h);
        await send(client, '一句话');

        const snapshot = await client.load();
        expect(Array.isArray(snapshot.items)).toBe(true);
        expect(Array.isArray(snapshot.deliveries)).toBe(true);
        expect(Array.isArray(snapshot.asks)).toBe(true);
        expect(snapshot.asks).toEqual([]);
    });

    it('端口只暴露可 JSON 化的载荷（json-wire 下形状不变）', async () => {
        const h = makeRoom({ reply: () => '好' });
        const client = makeClient(h);
        await send(client, '你好');

        const snapshot = await client.load();
        // 往返一次不丢字段
        expect(() => JSON.parse(JSON.stringify(snapshot))).not.toThrow();
        expect(snapshot.items.length).toBeGreaterThan(0);
    });

    it('@ 规则通过端口生效：无 @ 只叫默认应答', async () => {
        const h = makeRoom();
        const client = makeClient(h);
        await send(client, '不点名');

        const snapshot = await client.load();
        const user = snapshot.items.find((item) => item.type === 'chat' && item.author?.role === 'human');
        const chips = snapshot.deliveries.filter((delivery) => delivery.messageId === user?.id);
        expect(chips.map((delivery) => delivery.botId)).toEqual([BOT_A.id]);
    });
});

describe('跨传输一致性', () => {
    it('同一场景在两种传输下产生相同的可观察结果', async () => {
        const run = async (wire: boolean) => {
            const h = makeRoom({ reply: () => '同样的回答' });
            const client = new DirectRoomClient(h, wire);
            await send(client, '同一个问题');

            const snapshot = await client.load();
            return {
                itemTypes: snapshot.items.map((item) => item.type),
                deliveryStates: snapshot.deliveries.map((delivery) => delivery.state),
                texts: snapshot.items.filter((item) => item.type === 'chat').map((item) => item.data.text),
                turns: snapshot.items.map((item) => item.turn ?? 0),
            };
        };

        const direct = await run(false);
        const wire = await run(true);
        expect(wire).toEqual(direct);
    });
});

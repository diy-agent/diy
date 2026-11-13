// session.test.ts —— BotSession 的投递语义（next-step / next-turn / cancel）。
//
// 用假 run 代替真模型：这里要锁的是"什么时候开新 turn、什么时候插进当前 turn"，
// 而不是 SDK 内部怎么把消息拼进 prompt。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import { BotSession } from '../src/session';
import type { AgentEvent, Bot, Item } from '../src/types';

const BOT: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '', homeRoomId: 'room:1', modelKey: 'm' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
    session: BotSession;
    runs: string[];
    items: Item[];
    deliveries: string[];
    turns: number;
}

function makeSession(options: { hangOnAbort?: boolean } = {}): Harness {
    const runs: string[] = [];
    const items: Item[] = [];
    const deliveries: string[] = [];
    let turn = 0;

    const run = (async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        const turnId = input.turnId ?? 'turn';
        runs.push(turnId);
        yield { seq: 1, type: 'run.started', turnId, messageId: `msg-${runs.length}` };
        await sleep(5);
        if (options.hangOnAbort === true && runs.length === 1) {
            while (!input.signal.aborted) await sleep(2);
            yield { seq: 2, type: 'run.failed', turnId, message: 'aborted' };
            return;
        }
        yield { seq: 2, type: 'text.delta', messageId: `msg-${runs.length}`, delta: `reply-${runs.length}` };
        yield { seq: 3, type: 'message.completed', messageId: `msg-${runs.length}` };
        yield { seq: 4, type: 'run.completed', turnId };
    }) as (input: RunOptions) => AsyncIterable<AgentEvent>;

    const session = new BotSession({
        actor: 'room:1::bot:a',
        bot: BOT,
        modelKey: 'm',
        history: () => [],
        nextTurn: () => ({ turn: ++turn, turnId: `turn-${turn}` }),
        nextOrder: () => items.length + 1,
        onItem: (item) => items.push(item),
        onError: () => undefined,
        onDelivery: (messageId, state) => deliveries.push(`${messageId}:${state}`),
        run,
    });

    return { session, runs, items, deliveries, turns: turn };
}

describe('BotSession', () => {
    it('空闲时投 next-step：开一轮，消息在第一 step 送达', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toEqual(['m1:delivering', 'm1:delivered']);
        // 文本 + 完成态
        expect(h.items.some((item) => item.type === 'chat' && item.status === 'done')).toBe(true);
    });

    it('运行中投 next-step：不新开 turn（插进当前步边界）', async () => {
        const h = makeSession();
        const first = h.session.post({ messageId: 'm1', text: '第一句' });
        await sleep(2); // 让第一轮真正跑起来
        const second = h.session.post({ messageId: 'm2', text: '补充' });

        await Promise.all([first, second]);

        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toContain('m2:delivering');
    });

    it('运行中投 next-turn：等这一轮结束再开新一轮', async () => {
        const h = makeSession();
        const first = h.session.post({ messageId: 'm1', text: '第一句' });
        await sleep(2);
        const later = h.session.post({ messageId: 'm2', text: '下一轮说', mode: 'next-turn' });

        await Promise.all([first, later]);

        expect(h.runs).toEqual(['turn-1', 'turn-2']);
    });

    it('cancel：中止在跑的 turn，并丢弃排队', async () => {
        const h = makeSession({ hangOnAbort: true });
        const running = h.session.post({ messageId: 'm1', text: '会被取消' });
        await sleep(2);
        const queued = h.session.post({ messageId: 'm2', text: '排队也没了', mode: 'next-turn' });

        h.session.cancel();

        await Promise.all([running, queued]);
        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toContain('m1:failed');
    });

    it('cancel keepQueue：排队的 next-turn 不丢，取消这一轮后继续跑', async () => {
        const h = makeSession({ hangOnAbort: true });
        const running = h.session.post({ messageId: 'm1', text: '会被取消' });
        await sleep(2);
        const a = h.session.post({ messageId: 'm2', text: '留到下一轮 A', mode: 'next-turn' });
        const b = h.session.post({ messageId: 'm3', text: '留到下一轮 B', mode: 'next-turn' });

        h.session.cancel({ keepQueue: true });
        await Promise.all([running, a, b]);

        // 第一轮被 abort，队列里的两条进入第二轮
        expect(h.runs.length).toBe(2);
    });
});

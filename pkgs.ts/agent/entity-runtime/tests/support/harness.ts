// room.test.ts —— 房间（RoomActor）的领域行为。
//
// 这里不碰 HTTP、不碰 SSE、不碰真模型：用内存 sqlite + 脚本化 run。
// 要锁的是「Room 这一个概念」：路由、回合、结论、投递、成员覆盖。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../src/agent';
import { openStore, type Store } from '../../src/db';
import { RoomActor } from '../../src/room';
import type { AgentEvent, Bot, Item, Room, RoomEvent } from '../../src/types';

export const BOT_A: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '工程视角', homeRoomId: 'room:1', modelKey: 'm-default' };
export const BOT_B: Bot = { id: 'bot:b', name: 'cops', color: '#222', persona: '产品视角', homeRoomId: 'room:1', modelKey: 'm-default' };
export const HUMAN = { id: 'human:我', name: '我', color: '#999', role: 'human' as const };
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timeout');
        await sleep(5);
    }
}

export interface Harness {
    room: RoomActor;
    store: Store;
    events: RoomEvent[];
    runs: string[];
    items(): Item[];
    /** 直接订阅房间事件（无网络传输用） */
    subscribe(listener: (event: RoomEvent) => void): () => void;
}

export function makeRoom(
    options: { hang?: boolean; reply?: (bot: Bot) => string; members?: Room['members']; store?: Store } = {},
): Harness {
    const store = options.store ?? openStore(':memory:');
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
    const listeners = new Set<(event: RoomEvent) => void>();
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
        emit: (event) => {
            events.push(event);
            for (const listener of listeners) listener(event);
        },
        run,
    });

    return {
        room,
        store,
        events,
        runs,
        items: () => store.itemsOf(spec.id),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}


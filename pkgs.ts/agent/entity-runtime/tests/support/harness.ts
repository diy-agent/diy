// room.test.ts —— 房间（RoomActor）的领域行为。
//
// 这里不碰 HTTP、不碰 SSE、不碰真模型：用内存 sqlite + 脚本化 run。
// 要锁的是「Room 这一个概念」：路由、回合、结论、投递、成员覆盖。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../src/agent';
import { openStore, type Store } from '../../src/db';
import { RoomActor } from '../../src/room';
import type { AgentEvent, Bot, Item, Room, RoomEvent } from '../../src/types';

export const BOT_A: Bot = {
    id: 'bot:a',
    name: 'diy',
    color: '#111',
    persona: '工程视角',
    homeRoomId: 'room:1',
    modelKey: 'm-default',
};
export const BOT_B: Bot = {
    id: 'bot:b',
    name: 'cops',
    color: '#222',
    persona: '产品视角',
    homeRoomId: 'room:1',
    modelKey: 'm-default',
};
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
    spec: Room;
    events: RoomEvent[];
    runs: string[];
    /** 每个 session 跑一轮时实际拿到的 modelKey（验证"换模型生效"） */
    models: string[];
    items(): Item[];
    /** 直接订阅房间事件（无网络传输用） */
    subscribe(listener: (event: RoomEvent) => void): () => void;
    /** 用同一个 sqlite 重建房间（等价于重启进程） */
    rebuild(): Harness;
}

export function makeRoom(
    options: {
        hang?: boolean;
        reply?: (bot: Bot) => string;
        members?: Room['members'];
        store?: Store;
        /** 重启场景：用落库的那份 spec（名字/模型都是上次改过的值） */
        spec?: Room;
        /** 自定义 run（要调工具的场景用：ask 挂起 / 取消） */
        run?: (input: RunOptions) => AsyncIterable<AgentEvent>;
        /** 给了才有工具集（ask 工具需要在工具集里） */
        cwd?: string;
    } = {},
): Harness {
    const store = options.store ?? openStore(':memory:');
    const bots = [BOT_A, BOT_B];
    for (const bot of bots) store.upsertBot(bot);

    const spec: Room = options.spec ?? {
        id: 'room:1',
        type: 'project',
        data: { name: 'demo' },
        members: options.members ?? [{ botId: BOT_A.id, primary: true }, { botId: BOT_B.id }],
        modelKey: 'm-room',
    };
    store.setMembers(spec.id, spec.members);

    const events: RoomEvent[] = [];
    const listeners = new Set<(event: RoomEvent) => void>();
    const runs: string[] = [];
    const models: string[] = [];

    const scripted = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        runs.push(input.bot.name);
        models.push(input.modelKey);
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
        // 收尾事实必须发：真 agent 一定会给（`agent.ts` 末尾），脚本 run 不给的话
        // 这一轮会被判成 `unknown`（没收到收尾信号 = 按失败处理），于是结论发不出去。
        // 要演截断的测试自己发 `finishReason: 'length'`。
        yield {
            seq: 3,
            type: 'run.finished',
            turnId,
            finishReason: 'stop',
            steps: 1,
            maxOutputTokens: input.maxOutputTokens ?? 0,
        };
        yield { seq: 4, type: 'message.completed', messageId: `msg-${runs.length}` };
        yield { seq: 5, type: 'run.completed', turnId };
    } as (input: RunOptions) => AsyncIterable<AgentEvent>;
    const run = options.run ?? scripted;

    const room = new RoomActor({
        spec,
        store,
        // 与 server 一致：每次实时读库（改名 / 换模型这类改动才看得见）
        bots: () => store.listBots(),
        emit: (event) => {
            events.push(event);
            for (const listener of listeners) listener(event);
        },
        run,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    return {
        room,
        store,
        spec,
        events,
        runs,
        models,
        // 模拟进程重启：同一个 store 重新装配一个 RoomActor（房间元数据也从库里读）
        rebuild: () =>
            makeRoom({ ...options, store, spec: store.listRooms().find((room) => room.id === spec.id) ?? spec }),
        items: () => store.itemsOf(spec.id),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

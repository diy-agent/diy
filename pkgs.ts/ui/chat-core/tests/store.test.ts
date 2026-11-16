import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/store';
import type { ChatClient } from '../src/client';
import type { Snapshot, StreamEvent } from '../src/types';

const emptySnapshot: Snapshot = { items: [], deliveries: [], asks: [] };

function fakeClient(loads: Array<Snapshot | Error>) {
    const watchers: Array<(event: StreamEvent) => void> = [];
    const released: string[] = [];
    let calls = 0;
    const client: ChatClient = {
        load: async () => {
            const next = loads[Math.min(calls, loads.length - 1)]!;
            calls += 1;
            if (next instanceof Error) throw next;
            return next;
        },
        post: async () => undefined,
        watch: (_entityId, onEvent) => {
            watchers.push(onEvent);
            return () => undefined;
        },
        release: (entityId) => released.push(entityId),
    };
    return { client, watchers, loads: () => calls, released };
}

describe('ConversationStore', () => {
    it('构造时加载失败，首次 ready 后自动补拉（后端晚于页面起来也能接上）', async () => {
        const { client, watchers } = fakeClient([new Error('502'), emptySnapshot]);
        const store = new ConversationStore(client, 'proj:x');
        store.reload();
        await Promise.resolve();
        await Promise.resolve();
        expect(store.get().error).toContain('502');

        // 后端起来了，常驻流连上 → 必须重拉，否则这个房间永远是空的
        watchers[0]!({ kind: 'ready' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.get().error).toBeUndefined();
    });

    it('首次加载成功时，首次 ready 不重复拉取', async () => {
        const { client, watchers, loads } = fakeClient([emptySnapshot]);
        const store = new ConversationStore(client, 'proj:x');
        store.reload();
        await Promise.resolve();
        await Promise.resolve();
        expect(loads()).toBe(1);
        watchers[0]!({ kind: 'ready' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(loads()).toBe(1);
    });

    it('dispose：常驻订阅和还挂着的 post 流一起释放（切走房间不该留连接）', () => {
        const { client, released } = fakeClient([emptySnapshot]);
        const store = new ConversationStore(client, 'proj:x');
        store.dispose();
        expect(released).toEqual(['proj:x']);
    });
});

describe('ConversationStore.send', () => {
    it('首条事件到达即 resolve（不用等整轮结束），UI 才能只在这时清草稿', async () => {
        let unblock: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const client: ChatClient = {
            load: async () => emptySnapshot,
            post: async (_entityId, _command, onEvent) => {
                onEvent({ kind: 'ready' });
                await gate;
            },
        };
        const store = new ConversationStore(client, 'proj:x');
        await store.send('一句话');
        unblock?.();
    });

    it('没建流就失败时 reject（UI 据此把文字留在输入框）', async () => {
        const client: ChatClient = {
            load: async () => emptySnapshot,
            post: async () => {
                throw new Error('502');
            },
        };
        const store = new ConversationStore(client, 'proj:x');
        await expect(store.send('一句话')).rejects.toThrow('502');
        expect(store.get().error).toContain('502');
    });

    it('本地 abort 不算发送失败（消息可能已经到后端，别恢复成草稿）', async () => {
        const client: ChatClient = {
            load: async () => emptySnapshot,
            post: async () => {
                throw new Error('This operation was aborted');
            },
        };
        const store = new ConversationStore(client, 'proj:x');
        await expect(store.send('一句话')).resolves.toBeUndefined();
        expect(store.get().error).toBeUndefined();
    });

    it('空消息直接 resolve，不会发请求', async () => {
        let calls = 0;
        const client: ChatClient = {
            load: async () => emptySnapshot,
            post: async () => {
                calls += 1;
            },
        };
        const store = new ConversationStore(client, 'proj:x');
        await store.send('   ');
        expect(calls).toBe(0);
    });
});

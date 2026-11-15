import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/store';
import type { ChatClient } from '../src/client';
import type { Snapshot, StreamEvent } from '../src/types';

const emptySnapshot: Snapshot = { items: [], deliveries: [], asks: [] };

function fakeClient(loads: Array<Snapshot | Error>) {
    const watchers: Array<(event: StreamEvent) => void> = [];
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
    };
    return { client, watchers, loads: () => calls };
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
});

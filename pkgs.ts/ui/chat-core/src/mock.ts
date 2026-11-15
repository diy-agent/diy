// mock.ts —— 与 HttpChatClient 同契约的内存实现：UI 开发/测试/演示不需要后端。

import type { ChatClient } from './client';
import type { Command, Item, Snapshot, StreamEvent } from './types';

const HUMAN = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' as const };
const BOT = { id: 'bot:mock', name: 'mock', color: '#7cc4ff', role: 'bot' as const };

export interface MockOptions {
    /** 每个字符的间隔（ms）；0 = 立即返回全文 */
    tickMs?: number;
    /** 固定回复；缺省按输入回显 */
    reply?: (text: string) => string;
}

/** 供 parity 测试/Storybook 使用的脚本化客户端 */
export class MockChatClient implements ChatClient {
    private seq = 0;
    private readonly items = new Map<string, Item[]>();

    constructor(private readonly options: MockOptions = {}) {}

    async load(entityId: string): Promise<Snapshot> {
        return { items: this.items.get(entityId) ?? [], deliveries: [] };
    }

    async post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void): Promise<void> {
        if (command.kind === 'cancel') {
            onEvent({ kind: 'done' });
            return;
        }

        const now = Date.now();
        const turn = (this.items.get(entityId)?.at(-1)?.turn ?? 0) + 1;
        const turnId = `turn-mock-${now}`;

        const userItem: Item = {
            id: `u-${now}`,
            seq: ++this.seq,
            order: 1,
            turn,
            turnId,
            at: now,
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text: command.text },
        };
        this.push(entityId, userItem);
        onEvent({ kind: 'item', item: userItem });

        const text = this.options.reply?.(command.text) ?? `收到：${command.text}`;
        const botItem: Item = {
            id: `m-${now}`,
            seq: ++this.seq,
            order: 2,
            turn,
            turnId,
            at: now,
            status: 'streaming',
            author: BOT,
            type: 'chat',
            data: { text: '' },
        };
        this.push(entityId, botItem);
        onEvent({ kind: 'item', item: botItem });

        const tick = this.options.tickMs ?? 16;
        if (tick <= 0) {
            botItem.data = { text };
            botItem.status = 'done';
            this.push(entityId, botItem);
            onEvent({ kind: 'item', item: botItem });
        } else {
            for (let index = 1; index <= text.length; index += 2) {
                await new Promise((resolve) => setTimeout(resolve, tick));
                botItem.data = { text: text.slice(0, index) };
                onEvent({ kind: 'item', item: botItem });
            }
            botItem.status = 'done';
            this.push(entityId, botItem);
            onEvent({ kind: 'item', item: botItem });
        }
        onEvent({ kind: 'done' });
    }

    private push(entityId: string, item: Item): void {
        const list = this.items.get(entityId) ?? [];
        const index = list.findIndex((existing) => existing.id === item.id);
        this.items.set(
            entityId,
            index < 0 ? [...list, item] : list.map((existing) => (existing.id === item.id ? item : existing)),
        );
    }
}

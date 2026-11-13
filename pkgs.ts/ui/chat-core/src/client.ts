// client.ts —— ChatClient 契约 + HTTP 实现（SSE）。
//
// mock 与 http 同契约：UI/surface 只认识 ChatClient，不认识 fetch/SSE。

import type { Command, Delivery, Item, Snapshot, StreamEvent } from './types';

export interface ChatClient {
    load(entityId: string): Promise<Snapshot>;
    post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
}

function parseSseChunk(chunk: string, onEvent: (event: StreamEvent) => void): void {
    for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
            onEvent(JSON.parse(line.slice(6)) as StreamEvent);
        } catch {
            /* 忽略坏行 */
        }
    }
}

export class HttpChatClient implements ChatClient {
    private readonly controllers = new Map<string, AbortController>();

    constructor(private readonly base = '/api') {}

    async load(entityId: string): Promise<Snapshot> {
        const [history, deliveries] = await Promise.all([
            fetch(`${this.base}/entities/${encodeURIComponent(entityId)}/history`).then((res) => res.json() as Promise<{ items: Item[] }>),
            fetch(`${this.base}/entities/${encodeURIComponent(entityId)}/deliveries`).then((res) => res.json() as Promise<{ deliveries: Delivery[] }>),
        ]);
        return { items: history.items, deliveries: deliveries.deliveries };
    }

    async post(
        entityId: string,
        command: Command,
        onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        if (command.kind === 'cancel') {
            this.controllers.get(entityId)?.abort();
            onEvent({ kind: 'done' });
            return;
        }

        const controller = new AbortController();
        this.controllers.set(entityId, controller);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });

        try {
            const res = await fetch(`${this.base}/entities/${encodeURIComponent(entityId)}/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: command.text }),
                signal: controller.signal,
            });
            if (!res.ok || res.body === null) throw new Error(`chat → ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                for (;;) {
                    const index = buffer.indexOf('\n\n');
                    if (index < 0) break;
                    parseSseChunk(buffer.slice(0, index), onEvent);
                    buffer = buffer.slice(index + 2);
                }
            }
        } finally {
            signal?.removeEventListener('abort', abort);
            this.controllers.delete(entityId);
        }
    }
}

// HttpChatClient —— ChatClient 的 HTTP/SSE 实现。
//
// 这是**临时传输层**：只负责把命令发出去、把事件流读回来。
// 换成 diy-rpc 时新增 @diy-agent/chat-transport-rpc 即可，chat-core / surface 不用改。

import type { ChatClient, Command, Delivery, Item, Snapshot, StreamEvent } from '@diy-agent/chat-core';

export interface HttpChatClientOptions {
    /** API 前缀，默认 '/api' */
    base?: string;
    /** 便于测试/非浏览器环境注入 */
    fetchImpl?: typeof fetch;
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
    private readonly base: string;
    private readonly injected?: typeof fetch;

    constructor(options: HttpChatClientOptions = {}) {
        this.base = options.base ?? '/api';
        this.injected = options.fetchImpl;
    }

    /** 浏览器里 fetch 不能当方法调用（Illegal invocation），必须裸调 */
    private get fetchImpl(): typeof fetch {
        return this.injected ?? fetch;
    }

    async load(entityId: string): Promise<Snapshot> {
        const id = encodeURIComponent(entityId);
        const get = this.fetchImpl;
        const [history, deliveries] = await Promise.all([
            get(`${this.base}/entities/${id}/history`).then((res) => res.json() as Promise<{ items: Item[] }>),
            get(`${this.base}/entities/${id}/deliveries`).then((res) => res.json() as Promise<{ deliveries: Delivery[] }>),
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
        if (command.kind !== 'send') return;

        const controller = new AbortController();
        this.controllers.set(entityId, controller);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });

        try {
            const get = this.fetchImpl;
            const res = await get(`${this.base}/entities/${encodeURIComponent(entityId)}/chat`, {
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

// HttpChatClient —— ChatClient 的 HTTP/SSE 实现。
//
// 这是**临时传输层**：只负责把命令发出去、把事件流读回来。
// 换成 diy-rpc 时新增 @diy-agent/chat-transport-rpc 即可，chat-core / surface 不用改。

import type {
    ChatClient,
    Command,
    CompactOutcome,
    Delivery,
    Item,
    SessionInfo,
    Snapshot,
    StreamEvent,
} from '@diy-agent/chat-core';

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

    /** 拉 JSON：HTTP 错误与"不是 JSON"都转成人能读的错误（别把 SyntaxError 抛给用户） */
    private async getJson<T>(path: string): Promise<T> {
        const get = this.fetchImpl;
        const res = await get(`${this.base}${path}`);
        if (!res.ok) throw new Error(`加载失败：${path} → HTTP ${res.status}`);
        const text = await res.text();
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new Error(`后端没有返回 JSON：${path}（服务可能没起来）`);
        }
    }

    async load(entityId: string): Promise<Snapshot> {
        const id = encodeURIComponent(entityId);
        const [history, deliveries, asks] = await Promise.all([
            this.getJson<{ items: Item[] }>(`/rooms/${id}/history`),
            this.getJson<{ deliveries: Delivery[] }>(`/rooms/${id}/deliveries`),
            this.getJson<{ asks: Snapshot['asks']; answered: Snapshot['answeredAsks'] }>(
                `/rooms/${id}/asks`,
            ).catch(() => ({ asks: [], answered: [] })),
        ]);
        return {
            items: history.items,
            deliveries: deliveries.deliveries,
            asks: asks.asks ?? [],
            answeredAsks: asks.answered ?? [],
        };
    }

    /**
     * 常驻订阅。断线后指数退避重连（0.5s → 30s 封顶），每次连上都先发一条 `ready`，
     * 让上层补拉快照 —— 否则断线期间的提问 / 回复就永久丢了。
     */
    watch(entityId: string, onEvent: (event: StreamEvent) => void): () => void {
        let closed = false;
        let attempt = 0;
        let controller = new AbortController();
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        const loop = async (): Promise<void> => {
            while (!closed) {
                controller = new AbortController();
                try {
                    const get = this.fetchImpl;
                    const res = await get(`${this.base}/rooms/${encodeURIComponent(entityId)}/events`, {
                        headers: { accept: 'text/event-stream' },
                        signal: controller.signal,
                    });
                    if (!res.ok || res.body === null) throw new Error(`events → ${res.status}`);
                    attempt = 0;
                    onEvent({ kind: 'ready' });

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
                } catch {
                    // 落到下面的重连
                }
                if (closed) return;
                attempt += 1;
                await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
            }
        };
        void loop();

        return () => {
            closed = true;
            controller.abort();
        };
    }

    async sessions(entityId: string): Promise<SessionInfo[]> {
        const data = await this.getJson<{ sessions: SessionInfo[] }>(`/rooms/${encodeURIComponent(entityId)}/sessions`);
        return data.sessions;
    }

    async compact(
        entityId: string,
        botId: string,
        options: { keepLast?: number; maxChars?: number } = {},
    ): Promise<CompactOutcome> {
        const post = this.fetchImpl;
        const res = await post(
            `${this.base}/rooms/${encodeURIComponent(entityId)}/sessions/${encodeURIComponent(botId)}/compact`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(options),
            },
        );
        if (!res.ok) throw new Error(`压缩失败：HTTP ${res.status}`);
        return (await res.json()) as CompactOutcome;
    }

    async answerAsk(
        entityId: string,
        askId: string,
        answer: { values?: string[]; fields?: Record<string, string>; text?: string },
    ): Promise<void> {
        const post = this.fetchImpl;
        const res = await post(`${this.base}/rooms/${encodeURIComponent(entityId)}/asks/${encodeURIComponent(askId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(answer),
        });
        if (!res.ok) throw new Error(`回答失败：HTTP ${res.status}`);
    }

    async post(
        entityId: string,
        command: Command,
        onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        if (command.kind === 'cancel') {
            this.release(entityId);
            const get = this.fetchImpl;
            await get(`${this.base}/rooms/${encodeURIComponent(entityId)}/cancel`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    keepQueue: command.keepQueue === true,
                    ...(command.botId === undefined ? {} : { botId: command.botId }),
                }),
            }).catch(() => undefined);
            onEvent({ kind: 'done' });
            return;
        }
        if (command.kind !== 'send') return;

        // 同一房间只留一条 post 流：插话时上一句的流会一直挂到这轮结束（可能十几分钟）。
        // 浏览器对同源 HTTP/1.1 只有 6 条连接，攒满后新消息连发都发不出去。
        // 旧流收掉不影响服务端运行：事件还有常驻订阅这条路。
        this.release(entityId);

        const controller = new AbortController();
        this.controllers.set(entityId, controller);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });

        try {
            const get = this.fetchImpl;
            const res = await get(`${this.base}/rooms/${encodeURIComponent(entityId)}/chat`, {
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
            // 只清自己的：旧流 abort 后 finally 可能晚于新流注册，按 key 盲删会把新流弄丢
            if (this.controllers.get(entityId) === controller) this.controllers.delete(entityId);
        }
    }

    /** 收掉这个房间挂着的请求流（不影响服务端运行） */
    release(entityId: string): void {
        const controller = this.controllers.get(entityId);
        if (controller === undefined) return;
        this.controllers.delete(entityId);
        controller.abort();
    }
}

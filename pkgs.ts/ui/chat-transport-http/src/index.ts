// HttpChatClient —— ChatClient 的 HTTP/SSE 实现。
//
// 这是**临时传输层**：只负责把命令发出去、把事件流读回来。
// 换成 diy-rpc 时新增 @diy-agent/chat-transport-rpc 即可，chat-core / surface 不用改。
//
// 连接纪律（##stream-mux）：**一个 client 只有一条 SSE**（见 ./hub），房间是这条连接上的话题。
// 以前是「一个房间一条常驻流 + 每次发送再一条」，浏览器同源 6 条的上限下，多页工作台
// 3 个聊天页就吃满，之后连 /history 都永久排队。

import type {
    AskAnswer,
    ChatClient,
    Command,
    CompactOutcome,
    Delivery,
    Item,
    SessionInfo,
    Snapshot,
    StreamEvent,
} from '@diy-agent/chat-core';

import { StreamHub } from './hub';

export interface HttpChatClientOptions {
    /** API 前缀，默认 '/api' */
    base?: string;
    /**
     * 事件流的 WS 端点；缺省按当前页推导（`ws(s)://<host>/rpc`）。
     * 非浏览器环境（测试）必须显式给。
     */
    rpcUrl?: string;
    /** 便于测试/非浏览器环境注入 */
    fetchImpl?: typeof fetch;
}

/** 房间 → 话题名（与 server 的 `room:<id>` 一一对应） */
const topicOf = (entityId: string): string => `room:${entityId}`;

export class HttpChatClient implements ChatClient {
    private readonly base: string;
    private readonly injected?: typeof fetch;
    private readonly hub: StreamHub;

    constructor(options: HttpChatClientOptions = {}) {
        this.base = options.base ?? '/api';
        this.injected = options.fetchImpl;
        this.hub = new StreamHub({
            ...(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl }),
        });
    }

    /** 浏览器里 fetch 不能当方法调用（Illegal invocation），必须裸调 */
    private get fetchImpl(): typeof fetch {
        return this.injected ?? fetch;
    }

    /** 收掉那条共用连接（测试 / 应用卸载时用） */
    close(): void {
        this.hub.close();
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
            this.getJson<{ asks: Snapshot['asks']; answered: Snapshot['answeredAsks'] }>(`/rooms/${id}/asks`).catch(
                () => ({ asks: [], answered: [] }),
            ),
        ]);
        return {
            items: history.items,
            deliveries: deliveries.deliveries,
            asks: asks.asks ?? [],
            answeredAsks: asks.answered ?? [],
        };
    }

    /**
     * 常驻订阅：在这条共用连接上订一个话题。
     *
     * 断线重连、退避、`ready`（让上层补拉快照填断线期丢的事件）全在 `StreamHub` 里 ——
     * 它管的是连接，这里只管「我要看哪个房间」。
     */
    watch(entityId: string, onEvent: (event: StreamEvent) => void): () => void {
        return this.hub.subscribe(topicOf(entityId), onEvent);
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

    async answerAsk(entityId: string, askId: string, answer: AskAnswer): Promise<void> {
        const post = this.fetchImpl;
        const res = await post(`${this.base}/rooms/${encodeURIComponent(entityId)}/asks/${encodeURIComponent(askId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(answer),
        });
        if (!res.ok) {
            /*
             * 带上服务端的 error 文案：400（题对不上，比如缓存了旧题集）与 404（这一问已失效）
             * 对用户要做的事完全不同 —— 前者是「刷新重答」，后者是「这张卡没用了」。
             * 只报 HTTP 状态码，界面只能说一句含糊的「可能失效了」，把前者也引向重试。
             */
            const reason = await res
                .json()
                .then((body: unknown) => {
                    const error = (body as { error?: unknown } | undefined)?.error;
                    return typeof error === 'string' ? error : undefined;
                })
                .catch(() => undefined);
            throw new Error(reason ?? `回答失败：HTTP ${res.status}`);
        }
    }

    async cancelAsk(entityId: string, askId: string): Promise<void> {
        const post = this.fetchImpl;
        const res = await post(
            `${this.base}/rooms/${encodeURIComponent(entityId)}/asks/${encodeURIComponent(askId)}/cancel`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        );
        if (!res.ok) {
            const reason = await res
                .json()
                .then((body: unknown) => {
                    const error = (body as { error?: unknown } | undefined)?.error;
                    return typeof error === 'string' ? error : undefined;
                })
                .catch(() => undefined);
            throw new Error(reason ?? `撤回失败：HTTP ${res.status}`);
        }
    }

    async post(
        entityId: string,
        command: Command,
        onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const topic = topicOf(entityId);
        if (command.kind === 'cancel') {
            const post = this.fetchImpl;
            await post(`${this.base}/rooms/${encodeURIComponent(entityId)}/cancel`, {
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

        // 先在话题上挂一份**这次命令**的回调，再发：发送与「第一条事件」之间不留等待窗口。
        // （常驻的那份在 watch 里，长命；这份只管这次命令，发完就摘，不能越积越多。）
        const off = this.hub.subscribe(topic, onEvent);
        try {
            // 订阅本身是另一次请求（SSE 单工），断着时 ensure 返回 false：
            // 那就照发 —— 消息本身必须送到，事件由重连后的 ready + 补拉快照兜
            await this.hub.ensure(topic);
            const post = this.fetchImpl;
            const res = await post(`${this.base}/rooms/${encodeURIComponent(entityId)}/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: command.text }),
                ...(signal === undefined ? {} : { signal }),
            });
            if (!res.ok) throw new Error(`chat → ${res.status}`);
        } finally {
            off();
        }
    }
}

export { StreamHub, topicOfRoom, type StreamHubOptions } from './hub';

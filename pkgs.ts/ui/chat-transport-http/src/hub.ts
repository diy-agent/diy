// hub.ts —— 一条 WS（@diy-agent/rpc），多路分发（房间 → server-stream）。
//
// 为什么不再用 SSE（实测）：浏览器同源 HTTP/1.1 只有 6 条并发连接，而且**按 profile 共用**。
// 每个打开着的对话页一条常驻 SSE，6 页就把池吃满 —— 之后连 `/chat` 的 POST 都发不出去
// （不是慢，是不返回），界面上就是「发送中 / 执行中」永远不结束。
//
// WebSocket 不占这个池：一个页面一条 WS，房间是这条连接上的 server-stream。
// 命令面仍是 REST（见 `./index.ts`），这里只负责事件流。
//
// 连接**惰性**：第一次 subscribe 才拨号；断线退避重连，重连后把还在被监听的话题重开一遍，
// 每条流的首帧是 `{ kind: 'ready' }` —— 上层据此补拉快照，填断线期间的空洞。

import { ChannelClientBinding, type StreamHandle } from '@diy-agent/rpc';
import { WsTransport, connectWs } from '@diy-agent/rpc/ws/browser';
import type { StreamEvent } from '@diy-agent/chat-core';

const RECONNECT = { baseMs: 500, maxMs: 30_000 } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface StreamHubOptions {
    /** WS 端点；缺省按当前页推导（`ws(s)://<host>/rpc`） */
    rpcUrl?: string;
    /** 建连超时（透传 connectWs） */
    timeoutMs?: number;
}

const topicOfRoom = (roomId: string): string => `room:${roomId}`;
const roomOfTopic = (topic: string): string => topic.slice('room:'.length);

function defaultRpcUrl(): string | undefined {
    const where = (globalThis as { location?: { protocol: string; host: string } }).location;
    if (where === undefined) return undefined;
    return `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}/rpc`;
}

export class StreamHub {
    /** undefined = 没有可推导的地址（SSR / 单测）：不连、也不报错 —— 事件流在这里不是必需品 */
    private readonly rpcUrl: string | undefined;
    private readonly timeoutMs: number;
    /** 话题 → 监听者。连接断着也留着：重连后照这张表重开 */
    private readonly topics = new Map<string, Set<(event: StreamEvent) => void>>();
    /** 正在开的流（同一个话题可能被 watch 和 post 同时要，别开两遍） */
    private readonly starting = new Map<string, Promise<boolean>>();
    /** 话题 → 取消信号（stop 时 abort；rpc 会同时给服务端发 cancel 帧） */
    private readonly controllers = new Map<string, AbortController>();
    private transport: WsTransport | undefined;
    private binding: ChannelClientBinding | undefined;
    private started = false;
    private closed = false;
    private attempt = 0;

    constructor(options: StreamHubOptions = {}) {
        this.rpcUrl = options.rpcUrl ?? defaultRpcUrl();
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }

    /**
     * 订阅一个话题（房间）。返回退订函数。
     *
     * 已经连着会立刻开流；正在连 / 断着时只登记，等连上后由重连循环统一重开。
     */
    subscribe(topic: string, listener: (event: StreamEvent) => void): () => void {
        let set = this.topics.get(topic);
        if (set === undefined) {
            set = new Set();
            this.topics.set(topic, set);
        }
        set.add(listener);
        this.start();
        if (this.binding !== undefined) void this.ensure(topic);

        return () => {
            const current = this.topics.get(topic);
            if (current === undefined) return;
            current.delete(listener);
            if (current.size > 0) return;
            this.topics.delete(topic);
            this.stopTopic(topic);
        };
    }

    /**
     * 确保这条话题的流已经开了（发送前用：先订阅再发，事件才不会漏）。
     * 没连上时返回 false，调用方自己决定继续发还是等 —— 消息不该被事件流堵住。
     */
    ensure(topic: string): Promise<boolean> {
        this.start();
        if (this.closed || this.rpcUrl === undefined) return Promise.resolve(false);
        if (this.controllers.has(topic)) return Promise.resolve(true);
        const inflight = this.starting.get(topic);
        if (inflight !== undefined) return inflight;

        const run = this.openTopic(topic);
        this.starting.set(topic, run);
        void run.then(
            () => this.starting.delete(topic),
            () => this.starting.delete(topic),
        );
        return run;
    }

    close(): void {
        this.closed = true;
        this.topics.clear();
        for (const topic of [...this.controllers.keys()]) this.stopTopic(topic);
        this.transport?.close();
        this.transport = undefined;
        this.binding = undefined;
    }

    // ── 连接循环 ────────────────────────────────────────────────

    private start(): void {
        if (this.started || this.closed || this.rpcUrl === undefined) return;
        this.started = true;
        void this.loop();
    }

    private async loop(): Promise<void> {
        const url = this.rpcUrl;
        if (url === undefined) return;
        while (!this.closed) {
            try {
                const transport = new WsTransport(await connectWs(url, { timeoutMs: this.timeoutMs }));
                if (this.closed) {
                    transport.close();
                    return;
                }
                this.transport = transport;
                this.binding = new ChannelClientBinding(transport);
                this.attempt = 0;

                // 上次连接的流已经死了：清掉登记，重开还活着的那些话题
                this.controllers.clear();
                for (const topic of this.topics.keys()) void this.ensure(topic);

                await new Promise<void>((resolve) => {
                    transport.onClose(() => resolve());
                });
            } catch {
                /* 建连失败：走下面的退避 */
            }

            if (this.closed) return;
            this.binding = undefined;
            this.transport = undefined;
            this.controllers.clear();

            const wait = Math.min(RECONNECT.maxMs, RECONNECT.baseMs * 2 ** Math.min(this.attempt, 6));
            this.attempt += 1;
            await sleep(wait);
        }
    }

    // ── 单条流 ──────────────────────────────────────────────────

    private async openTopic(topic: string): Promise<boolean> {
        const binding = this.binding;
        if (binding === undefined) return false;

        const controller = new AbortController();
        let handle: StreamHandle<unknown>;
        try {
            handle = await binding.serverStream(
                'room',
                { input: { room: roomOfTopic(topic) } },
                { signal: controller.signal },
            );
        } catch {
            return false;
        }

        // 等 ack 期间连接换了：这条流属于旧连接，直接丢弃
        if (this.binding !== binding) {
            controller.abort();
            return false;
        }

        this.controllers.set(topic, controller);
        void this.pump(topic, handle, controller);
        return true;
    }

    private async pump(topic: string, handle: StreamHandle<unknown>, controller: AbortController): Promise<void> {
        try {
            for await (const event of handle) {
                for (const listener of this.topics.get(topic) ?? []) listener(event as StreamEvent);
            }
        } catch {
            /* 连接断了 / 被 abort：交给 loop 重连后重开 */
        } finally {
            if (this.controllers.get(topic) === controller) this.controllers.delete(topic);
        }
    }

    private stopTopic(topic: string): void {
        const controller = this.controllers.get(topic);
        this.controllers.delete(topic);
        controller?.abort();
    }
}

export { topicOfRoom };

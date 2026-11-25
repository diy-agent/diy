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
import type { ActivityFrame } from '@diy-agent/protocol';

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

/**
 * 活动流上「什么算数据」：只有 `{ kind: 'activity' }` 那一帧。
 *
 * 服务端的 `roomFrames` 对**每条** server-stream 都先发一条 `{ kind: 'ready' }`（「从现在起
 * 事件连续」），活动流也照发。而 `ActivityFrame` 里没有这个 kind —— 不挡掉的话，监听者按
 * `frame.rooms` 取值就炸在 `undefined` 上，异常从 `pump` 的 for-await 里逃出来、把整条流
 * 判死：此后**再也不会有活动帧**，界面上就是「运行状态不更新，刷新页面才好」。
 *
 * 挡住的地方放在这里（话题语义的拥有者），不是每个监听者各写一遍 `if`。
 */
export function activityFrameOf(value: unknown): ActivityFrame | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const frame = value as { kind?: unknown; rooms?: unknown; jobs?: unknown };
    if (frame.kind !== 'activity') return undefined;
    if (!Array.isArray(frame.rooms) || typeof frame.jobs !== 'number') return undefined;
    return value as ActivityFrame;
}

/**
 * 实例级活动流的话题名（服务端 rpc.ts 的 `ACTIVITY_TOPIC` 必须同值）。
 *
 * 它不是房间：`openTopic` 据此改走 `activity` 那条 server-stream（不带房间参数）。
 */
const ACTIVITY_TOPIC = '@activity';

function defaultRpcUrl(): string | undefined {
    const where = (globalThis as { location?: { protocol: string; host: string } }).location;
    if (where === undefined) return undefined;
    return `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}/rpc`;
}

export class StreamHub {
    /** undefined = 没有可推导的地址（SSR / 单测）：不连、也不报错 —— 事件流在这里不是必需品 */
    private readonly rpcUrl: string | undefined;
    private readonly timeoutMs: number;
    /**
     * 话题 → 监听者。连接断着也留着：重连后照这张表重开。
     *
     * 值是 `unknown`：房间话题送 `StreamEvent`、`@activity` 送 `ActivityFrame` —— 两条流的
     * 帧型不同，但「按话题分发」这套机制一模一样，不为此分两个 hub。
     */
    private readonly topics = new Map<string, Set<(event: unknown) => void>>();
    /** 话题 → 单条流意外结束后重开的次数（成功收到帧就归零）：退避用 */
    private readonly streamAttempts = new Map<string, number>();
    /** 正在开的流（同一个话题可能被 watch 和 post 同时要，别开两遍） */
    private readonly starting = new Map<string, Promise<boolean>>();
    /** 话题 → 取消信号（stop 时 abort；rpc 会同时给服务端发 cancel 帧） */
    private readonly controllers = new Map<string, AbortController>();
    private transport: WsTransport | undefined;
    private binding: ChannelClientBinding | undefined;
    /** 等连接的命令调用（首次 refresh 可能早于 watch） */
    private readonly waiters = new Set<{
        resolve: (binding: ChannelClientBinding) => void;
        reject: (error: Error) => void;
    }>();
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
        return this.listen(topic, listener as (event: unknown) => void);
    }

    /**
     * 订阅**实例级活动**（谁在跑 / 几个作业在跑）。首帧是当前快照，不是 `ready`。
     *
     * 与房间流同一条连接、同一套重连：断线重连后这张表里的活动话题也会被重开一遍。
     */
    subscribeActivity(listener: (frame: ActivityFrame) => void): () => void {
        return this.listen(ACTIVITY_TOPIC, listener as (event: unknown) => void);
    }

    private listen(topic: string, listener: (event: unknown) => void): () => void {
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

    /**
     * 发一条命令（`diy2.rooms.list` 这类）。没有连接就等（首次 refresh 早于 watch），
     * 等不到（超时 / 关闭）就抛 —— 命令不能静默丢。
     */
    async invoke<T>(method: string, input: unknown): Promise<T> {
        const binding = await this.connection();
        return binding.invoke<unknown, T>(method, { input });
    }

    private connection(): Promise<ChannelClientBinding> {
        if (this.binding !== undefined) return Promise.resolve(this.binding);
        if (this.closed) return Promise.reject(new Error('rpc 连接已关闭'));
        this.start();
        return new Promise<ChannelClientBinding>((resolve, reject) => {
            const waiter = { resolve, reject };
            this.waiters.add(waiter);
            setTimeout(() => {
                if (!this.waiters.delete(waiter)) return;
                reject(new Error(`rpc 连接超时（${this.timeoutMs}ms）`));
            }, this.timeoutMs);
        });
    }

    private settleWaiters(binding?: ChannelClientBinding): void {
        for (const waiter of this.waiters) {
            if (binding === undefined) waiter.reject(new Error('rpc 连接断开'));
            else waiter.resolve(binding);
        }
        this.waiters.clear();
    }

    close(): void {
        this.closed = true;
        this.topics.clear();
        for (const topic of [...this.controllers.keys()]) this.stopTopic(topic);
        this.transport?.close();
        this.transport = undefined;
        this.binding = undefined;
        this.settleWaiters();
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
                this.settleWaiters(this.binding);

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
            this.settleWaiters();

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
            // 活动流不属任何房间：走 `activity` 那条 server-stream（入参为空）
            handle =
                topic === ACTIVITY_TOPIC
                    ? await binding.serverStream('activity', { input: {} }, { signal: controller.signal })
                    : await binding.serverStream(
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
                const value = topic === ACTIVITY_TOPIC ? activityFrameOf(event) : event;
                // 活动流上的 `ready` / 认不出的帧：既不是数据，也不是终态，跳过就是了
                if (value === undefined) continue;
                this.streamAttempts.delete(topic);
                for (const listener of this.topics.get(topic) ?? []) {
                    // 单个监听者抛错不能带走整条流：一条流喂多个监听者，谁炸谁负责
                    try {
                        listener(value);
                    } catch (error) {
                        console.error(`[StreamHub] 监听者抛错（${topic}）：`, error);
                    }
                }
            }
        } catch {
            /* 连接断了 / 被 abort：交给 loop 重连后重开 */
        } finally {
            // 不是我们主动停的（stopTopic 先删 controllers 再 abort）⇒ 这条流自己结束了
            if (this.controllers.get(topic) === controller) {
                this.controllers.delete(topic);
                this.reopen(topic);
            }
        }
    }

    /**
     * 单条流意外结束（服务端关流 / 这条流报错）时把它重开。
     *
     * 不重开就等于**静默死亡**：`topics` 里还留着监听者，连接也还活着，所以整条连接的重连
     * 逻辑不会介入 —— 页面上表现为「状态卡住，刷新才好」。退避与整连接重连同参。
     */
    private reopen(topic: string): void {
        if (this.closed || !this.topics.has(topic)) return;
        const attempt = this.streamAttempts.get(topic) ?? 0;
        this.streamAttempts.set(topic, attempt + 1);
        const wait = Math.min(RECONNECT.maxMs, RECONNECT.baseMs * 2 ** Math.min(attempt, 6));
        void sleep(wait).then(() => {
            if (this.closed || !this.topics.has(topic) || this.controllers.has(topic)) return;
            void this.ensure(topic);
        });
    }

    private stopTopic(topic: string): void {
        const controller = this.controllers.get(topic);
        this.controllers.delete(topic);
        controller?.abort();
    }
}

export { topicOfRoom };

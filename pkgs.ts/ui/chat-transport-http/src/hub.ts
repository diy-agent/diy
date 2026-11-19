// hub.ts —— 一条 SSE，多路分发（话题）。
//
// 为什么（实测）：浏览器同源 HTTP/1.1 只有 6 条并发连接，且**按 profile 共用**。6 条常驻
// SSE 占满后，同 profile 下对这个源的所有请求永久排队 —— 连 `/history`、点「停止」的 POST
// 都不返回。而「每个打开着的对话页一条常驻流」在多页工作台里就是 3 页吃满。
//
// 所以传输层只开**一条**连接，房间是它上面的话题：
//   watch(roomId)  → subscribe('room:<id>')
//   post(roomId)   → 在同一个话题上临时挂一份回调（发送期间），不另开连接
//
// 与 server 端 `apps/diy2/server/stream.ts` 一一对应：首帧 `$conn` 交身份，
// 订阅/退订走 POST，事件帧是 `{ topic, event }`。

import type { StreamEvent } from '@diy-agent/chat-core';

/** 首帧的身份话题：服务端说了算，客户端不许自造连接 id */
const CONN_TOPIC = '$conn';

const RECONNECT = { baseMs: 500, maxMs: 30_000 } as const;

interface Frame {
    topic: string;
    event: unknown;
}

/** 一帧 `data:` 的内容；坏行（心跳 / 半包）返回 undefined */
function parseFrame(chunk: string): Frame | undefined {
    for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
            const parsed = JSON.parse(line.slice(6)) as Frame;
            if (typeof parsed.topic === 'string') return parsed;
        } catch {
            /* 忽略坏行 */
        }
    }
    return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class StreamHub {
    /** 话题 → 监听者。连接断着也留着：重连后照这张表重订 */
    private readonly topics = new Map<string, Set<(event: StreamEvent) => void>>();
    /** 当前这条连接上**已经订上**的话题（换连接就清空） */
    private readonly remote = new Set<string>();
    /** 正在飞的订阅请求：同一个话题可能被 watch 和 post 同时要，别订两遍 */
    private readonly pending = new Map<string, Promise<boolean>>();
    private readonly base: string;
    private readonly getFetch: () => typeof fetch;
    private controller: AbortController | undefined;
    /** 当前连接的身份；undefined = 正在连 / 断着 */
    private connId: string | undefined;
    private attempt = 0;
    private closed = false;

    constructor(options: { base: string; fetch: () => typeof fetch }) {
        this.base = options.base;
        this.getFetch = options.fetch;
        void this.loop();
    }

    /**
     * 订阅一个话题。返回退订函数。
     *
     * 已经连着的时候会立刻在服务端补订（后来才打开的页），但**不补发 `ready`** ——
     * `ready` 的语义是「这条连接从现在开始是连续的」，上层收到它就补拉快照；
     * 一个刚打开的页自己已经 load 过，补一次只会白拉一遍历史。
     */
    subscribe(topic: string, listener: (event: StreamEvent) => void): () => void {
        let set = this.topics.get(topic);
        if (set === undefined) {
            set = new Set();
            this.topics.set(topic, set);
        }
        set.add(listener);
        if (this.connId !== undefined) void this.sync(topic);

        return () => {
            const current = this.topics.get(topic);
            if (current === undefined) return;
            current.delete(listener);
            if (current.size > 0) return;
            this.topics.delete(topic);
            // 最后一个监听者走了：服务端也别再推这条话题（没人看的房间不该占广播）
            if (this.connId !== undefined && this.remote.delete(topic)) void this.unsubscribeRemote(this.connId, topic);
        };
    }

    /**
     * 确保这条话题在服务端订上了（发送前用：先订再发，事件才不会漏）。
     * 断着时返回 false，调用方自己决定继续发还是等。
     */
    async ensure(topic: string): Promise<boolean> {
        if (this.connId === undefined) return false;
        if (this.remote.has(topic)) return true;
        return this.sync(topic);
    }

    close(): void {
        this.closed = true;
        this.controller?.abort();
        this.topics.clear();
        this.remote.clear();
        this.pending.clear();
        this.connId = undefined;
    }

    /** 一条连接的重连循环：断了就退避重连，退避上限 30s */
    private async loop(): Promise<void> {
        while (!this.closed) {
            this.controller = new AbortController();
            try {
                await this.connect(this.controller.signal);
            } catch {
                // 落到下面的退避；真正的失败原因在 UI 上体现为「没有新事件」
            }
            this.connId = undefined;
            this.remote.clear();
            this.pending.clear();
            if (this.closed) return;
            // 第一次重试就等 base（attempt 此时还是 0-based 的「已经失败过几次」）
            const wait = Math.min(RECONNECT.maxMs, RECONNECT.baseMs * 2 ** Math.min(this.attempt, 6));
            this.attempt += 1;
            await sleep(wait);
        }
    }

    private async connect(signal: AbortSignal): Promise<void> {
        // 注意：getFetch 是「取 fetch 的函数」（浏览器里 fetch 必须裸调，不能当方法取）
        const get = this.getFetch();
        const res = await get(`${this.base}/stream`, { headers: { accept: 'text/event-stream' }, signal });
        if (!res.ok || res.body === null) throw new Error(`stream → ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const index = buffer.indexOf('\n\n');
                if (index < 0) break;
                const frame = parseFrame(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
                if (frame === undefined) continue;
                if (frame.topic === CONN_TOPIC) {
                    // 拿到身份 = 这条连接可用了：把还在被监听的话题全部重订一遍
                    // （断线期间服务端已经把我们忘了）
                    await this.handshake(String((frame.event as { conn?: unknown } | null)?.conn ?? ''));
                    continue;
                }
                for (const listener of Array.from(this.topics.get(frame.topic) ?? [])) {
                    listener(frame.event as StreamEvent);
                }
            }
        }
    }

    private async handshake(connId: string): Promise<void> {
        if (connId === '') return;
        this.connId = connId;
        this.attempt = 0;
        this.remote.clear();
        this.pending.clear();
        // 快照：sync 是异步的，途中可能有页在订/退（迭代器同栈会跳元素）
        await Promise.all(
            Array.from(this.topics, async ([topic, listeners]) => {
                if (!(await this.sync(topic))) return;
                // ready = 「从这条连接开始，这个房间的事件是连续的了」→ 上层补拉快照填断线
                for (const listener of Array.from(listeners)) listener({ kind: 'ready' });
            }),
        );
    }

    private sync(topic: string): Promise<boolean> {
        const connId = this.connId;
        if (connId === undefined) return Promise.resolve(false);
        if (this.remote.has(topic)) return Promise.resolve(true);
        const inflight = this.pending.get(topic);
        if (inflight !== undefined) return inflight;

        const run = (async () => {
            const ok = await this.postJson('/stream/subscribe', { conn: connId, topic });
            this.pending.delete(topic);
            // 回来时可能已经换连接了：那个话题属于上一条连接，别记到新连接上
            if (ok && this.connId === connId) this.remote.add(topic);
            return ok;
        })();
        this.pending.set(topic, run);
        return run;
    }

    private async unsubscribeRemote(connId: string, topic: string): Promise<void> {
        await this.postJson('/stream/unsubscribe', { conn: connId, topic });
    }

    private async postJson(path: string, body: unknown): Promise<boolean> {
        const post = this.getFetch();
        try {
            const res = await post(`${this.base}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}

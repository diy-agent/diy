// stream.ts —— 一条 SSE 连接承载多个话题（房间），带话题订阅表。
//
// 为什么要有它（实测，不是推测）：浏览器同源 HTTP/1.1 只有 **6 条并发连接**，而且这个
// 配额是 **per profile**（同 profile 的所有标签页共用）。6 条常驻 SSE 占满后，同 profile
// 下对这个源的**所有**请求永久排队 —— 不只新页面打不开，连 `/history`、点「停止」的
// POST 都发不出去（不是慢，是不返回）。而多页工作台里每个「开着的对话页」都要一条常驻流：
// 3 个聊天页就把上限吃满。
//
// 这里把「每页一条连接」换成「每个 app 实例一条连接 + 话题订阅」：
//   连接数 = O(标签页数)，与开多少页无关。
//
// 分工：本文件只管「连接 → 话题 → 帧」。
//   · 话题背后的数据源由调用方通过 `onFirstSubscriber` 接上（diy2 里是房间广播）；
//   · 一条话题只在**第一个**订阅者出现时接数据源，最后一个离开时调它的 teardown ——
//     否则「没人听的房间」也会一直挂在广播上（那正是这次要消掉的老毛病的另一半）。

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 帧格式与服务端约定：一条 `data:` 里是 `{ topic, event }` */
export interface StreamHubOptions {
    /**
     * 某条话题的第一个订阅者出现时调用，用来接上真正的数据源。
     * `push` 会把事件发给这条话题的**所有**连接（不是只有触发订阅的那条）。
     */
    onFirstSubscriber?: (topic: string, push: (event: unknown) => void) => (() => void) | undefined;
}

export interface StreamHub {
    /** 当前挂着的连接数（测试与运维用：它是"通讯保障"的唯一硬指标） */
    readonly size: number;
    /** GET /api/stream：升级成 SSE，回一句身份 */
    handle: (req: IncomingMessage, res: ServerResponse) => void;
    /** 把某条连接订到某个话题上；连接不存在（刚断 / 进程重启）返回 false */
    subscribe: (connId: string, topic: string) => boolean;
    unsubscribe: (connId: string, topic: string) => void;
    /** 把一条话题从所有连接上摘掉（实体被删了：话题背后已经没有东西可推） */
    drop: (topic: string) => void;
    /** 关掉所有连接（进程退出 / dev 重启） */
    close: () => void;
}

/** 身份话题：首帧告诉客户端"你这条连接叫什么" */
export const CONN_TOPIC = '$conn';

/** 心跳：代理 / 浏览器会掐掉长时间无数据的连接 */
const PING_MS = 20_000;

interface Conn {
    res: ServerResponse;
    /** 这条连接订着的话题 */
    topics: Set<string>;
    timer: ReturnType<typeof setInterval>;
}

interface TopicEntry {
    conns: Set<Conn>;
    /** 最后一个订阅者离开时调：把数据源摘掉 */
    teardown?: (() => void) | undefined;
}

export function createStreamHub(options: StreamHubOptions = {}): StreamHub {
    const conns = new Map<string, Conn>();
    const topics = new Map<string, TopicEntry>();
    let nextConnId = 1;

    function write(conn: Conn, topic: string, event: unknown): void {
        // 客户端可能已经断开（刷新 / abort / 进程重启）：别往死 socket 上写
        if (conn.res.destroyed || conn.res.writableEnded) return;
        try {
            conn.res.write(`data: ${JSON.stringify({ topic, event })}\n\n`);
        } catch {
            // 写失败说明连接没了，交给 close 事件清理
        }
    }

    function join(conn: Conn, topic: string): void {
        if (conn.topics.has(topic)) return;
        let entry = topics.get(topic);
        if (entry === undefined) {
            // 先把**这条连接**放进集合再接数据源：onFirstSubscriber 里常常同步 push 一帧
            // （贴快照），那时集合若还是空的，这一帧就白丢了
            const created: TopicEntry = { conns: new Set([conn]) };
            topics.set(topic, created);
            created.teardown = options.onFirstSubscriber?.(topic, (event) => {
                for (const target of created.conns) write(target, topic, event);
            });
            entry = created;
        }
        entry.conns.add(conn);
        conn.topics.add(topic);
    }

    function leave(conn: Conn, topic: string): void {
        const entry = topics.get(topic);
        if (entry === undefined) return;
        entry.conns.delete(conn);
        conn.topics.delete(topic);
        if (entry.conns.size > 0) return;
        // 没人听了：摘数据源，别让空话题永远占着广播
        entry.teardown?.();
        topics.delete(topic);
    }

    function closeConn(connId: string): void {
        const conn = conns.get(connId);
        if (conn === undefined) return;
        conns.delete(connId);
        clearInterval(conn.timer);
        // 快照：leave() 会从 conn.topics 里删元素
        for (const topic of Array.from(conn.topics)) leave(conn, topic);
    }

    return {
        get size() {
            return conns.size;
        },

        handle(_req, res) {
            const connId = `c${nextConnId++}`;
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                // nginx 一类反代会缓冲 SSE，变成「憋到断开才吐」
                'x-accel-buffering': 'no',
            });
            const conn: Conn = {
                res,
                topics: new Set(),
                timer: setInterval(() => {
                    if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
                }, PING_MS),
            };
            conns.set(connId, conn);
            // 身份由服务端给：客户端自造 id 会和「上一个进程 / 上一次连接」撞车，
            // 而那正是重连后订阅挂空的原因
            write(conn, CONN_TOPIC, { conn: connId });
            res.on('close', () => closeConn(connId));
        },

        subscribe(connId, topic) {
            const conn = conns.get(connId);
            if (conn === undefined) return false;
            join(conn, topic);
            return true;
        },

        unsubscribe(connId, topic) {
            const conn = conns.get(connId);
            if (conn === undefined) return;
            leave(conn, topic);
        },

        drop(topic) {
            const entry = topics.get(topic);
            if (entry === undefined) return;
            // 快照：leave() 会把这些连接从集合里删掉（同栈迭代会跳元素）
            for (const conn of Array.from(entry.conns)) leave(conn, topic);
        },

        close() {
            for (const connId of Array.from(conns.keys())) {
                const conn = conns.get(connId);
                conn?.res.end();
                closeConn(connId);
            }
        },
    };
}

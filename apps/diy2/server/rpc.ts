// rpc.ts —— diy2 的 RPC 面（WebSocket）：房间事件流 + 订阅观测。
//
// 为什么先只搬事件流：常驻连接是浏览器「同源 6 条」上限的根因。命令面后来也搬进来了
// （`diy2.models.list` 起走同一条连接；REST 只剩静态资源与 `/health`）。
// 一条 WS 上可以开多条 server-stream（每个房间一条），连接数从「打开的页面数」降到「1 条」。
//
// 协议复用 `@diy-agent/rpc`：请求 id / 流 / 取消 / 坏帧关闭终态都不在这里重写。

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { ChannelServerBinding, RpcSchema } from '@diy-agent/rpc';
import { WsTransport } from '@diy-agent/rpc/ws';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

/** WS 端点；与 HTTP 共用同一个 server（`upgrade` 分流） */
export const RPC_PATH = '/rpc';

/**
 * 全局活动流在「这条连接在看什么」里的占位名（`streams()` 排查用）。
 *
 * **不是房间**：它只是一条实例级的流，客户端用同一个值发订阅（见 chat-transport-rpc 的
 * `ACTIVITY_TOPIC`）—— 两边必须一致，改一处就要改另一处。
 */
export const ACTIVITY_TOPIC = '@activity';

/** 与 `./stream.ts` 的帧同一形状：`RoomEvent | { kind: 'done' }` */
type Frame = unknown;
type Attach = (roomId: string, sink: (frame: Frame) => void) => () => void;

export const eventsApi = RpcSchema.group({
    children: {
        /**
         * 订阅一个房间。连上立刻先发一条 `{ kind: 'ready' }`：
         * 客户端据此知道「从现在起事件连续了」，补拉一次快照填断线期间的空洞。
         */
        room: RpcSchema.serverStream({ input: { room: z.string() }, output: z.unknown() }),
        /**
         * 全局活动（实例级）：谁在跑 / 几个作业在跑。**不带房间号** —— 一条流汇报全实例，
         * 首个帧就是当前快照（而 `ready` 只说明「往后连续」，不是数据）。
         */
        activity: RpcSchema.serverStream({ input: {}, output: z.unknown() }),
        /** 当前连接与它们在看的房间（dev app / 排查用） */
        streams: RpcSchema.unary({
            input: {},
            output: z.array(z.object({ conn: z.string(), rooms: z.array(z.string()), since: z.number() })),
        }),
    },
});

export interface RpcStreamInfo {
    conn: string;
    rooms: string[];
    since: number;
}

interface ConnState {
    conn: string;
    rooms: Set<string>;
    since: number;
}

export interface RpcSocketOptions {
    /** 接到广播上（`app.ts` 的 `attach`）：返回 teardown */
    attach: Attach;
    /**
     * 接到**实例级活动**上：返回 teardown。
     *
     * 与 `attach` 分开是因为它不按房间分：一条流一个 sink，全实例的快照由宿主算好推。
     */
    attachActivity?: (sink: (frame: Frame) => void) => () => void;
    /** 房间当前是否存在（删掉的房间不该再被订阅） */
    hasRoom: (roomId: string) => boolean;
    /** 宿主在这里挂自己的 RPC 面（命令面：rooms / bots / chat / …） */
    bind?: (server: ChannelServerBinding) => void;
    /** 缺省 `/rpc` */
    path?: string;
}

export interface RpcSocket {
    /**
     * 处理一条 upgrade。返回 true = 这条连接归我（`/rpc`）；
     * false = 别人处理（dev 里 vite 的 HMR），**不要动 socket**。
     */
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
    /** 所有连接上正在订阅的房间（快照） */
    streams: () => RpcStreamInfo[];
    close: () => void;
}

/**
 * 一条「房间 → 订阅者」的异步队列。
 *
 * 事件是**推**进来的（广播），而 rpc 的 server-stream 是**拉**的（async generator）：
 * 这里做一次转换。取消（客户端断开 / 显式 cancel）走 signal，一条路径收尾。
 */
function roomFrames(roomId: string, signal: AbortSignal, attach: Attach): AsyncGenerator<Frame> {
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;

    const ping = (): void => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };

    const off = attach(roomId, (frame) => {
        queue.push(frame);
        ping();
    });
    const onAbort = (): void => ping();
    signal.addEventListener('abort', onAbort, { once: true });

    return (async function* () {
        try {
            yield { kind: 'ready' };
            while (!signal.aborted) {
                if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
                while (queue.length > 0) yield queue.shift();
            }
        } finally {
            off();
            signal.removeEventListener('abort', onAbort);
        }
    })();
}

export function createRpcSocket(options: RpcSocketOptions): RpcSocket {
    const path = options.path ?? RPC_PATH;
    const wss = new WebSocketServer({ noServer: true });
    const conns = new Map<WebSocket, ConnState>();
    let seq = 0;

    const streams = (): RpcStreamInfo[] =>
        [...conns.values()].map((state) => ({
            conn: state.conn,
            rooms: [...state.rooms],
            since: state.since,
        }));

    wss.on('connection', (socket: WebSocket) => {
        const state: ConnState = { conn: `ws-${++seq}`, rooms: new Set(), since: Date.now() };
        conns.set(socket, state);
        const binding = new ChannelServerBinding(new WsTransport(socket));

        binding._on('room', eventsApi.room, async function* ({ input, signal }) {
            const room = input.room;
            if (!options.hasRoom(room)) throw new Error(`房间不存在：${room}`);
            state.rooms.add(room);
            try {
                yield* roomFrames(room, signal, options.attach);
            } finally {
                state.rooms.delete(room);
            }
        });

        // 活动流：不校验房间（它不属于任何房间）。宿主没挂 attachActivity 就当成空流 ——
        // 老装配（只房间）照样能跑，只是客户端拿不到全局帧
        binding._on('activity', eventsApi.activity, async function* ({ signal }) {
            const attachActivity = options.attachActivity;
            if (attachActivity === undefined) {
                yield await new Promise<never>(() => undefined);
                return;
            }
            state.rooms.add(ACTIVITY_TOPIC);
            try {
                // 活动流没有「房间号」这个维度：包一层把 `Attach` 的 (roomId, sink) 适配成 sink
                yield* roomFrames(ACTIVITY_TOPIC, signal, (_topic, sink) => attachActivity(sink));
            } finally {
                state.rooms.delete(ACTIVITY_TOPIC);
            }
        });

        binding._on('streams', eventsApi.streams, async () => streams());
        options.bind?.(binding);

        socket.on('close', () => {
            conns.delete(socket);
        });
    });

    return {
        handleUpgrade(req, socket, head) {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname !== path) return false;
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
            return true;
        },
        streams,
        close() {
            conns.clear();
            for (const client of wss.clients) client.terminate();
            wss.close();
        },
    };
}

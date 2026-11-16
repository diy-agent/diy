// net-link.ts — 一条**真**链路：unix domain socket + 换行分隔的 JSON 帧。
//
// 为什么放在 examples/ 而不是 src/：actor 内核的判据之一是「src 里出现 `from 'node:` = 0」
// （docs/06 §九）。IO 属于适配器，适配器属于宿主 —— 这里就是那个宿主，也是给你抄的那份。
//
// 适配器只搬字符串：帧的编解码由 `src/transport.ts` 的 `frameLink` 负责，坏帧丢在链路层。

import { createServer, createConnection, type Server, type Socket } from 'node:net';

import { frameLink, type Link, type TextLink } from '../../src/index.js';

/** 帧在线上怎么走：一行一帧（`\n` 分隔）。大帧/二进制要另加长度前缀，actor 不管这事 */
function socketText(socket: Socket): TextLink {
    const handlers = new Set<(text: string) => void>();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
            const at = buffer.indexOf('\n');
            if (at < 0) break;
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (line.trim() === '') continue;
            for (const handler of handlers) handler(line);
        }
    });
    return {
        send(text) {
            if (!socket.destroyed) socket.write(`${text}\n`);
        },
        onText(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
    };
}

export interface ListenOptions {
    /** socket 文件路径（unix domain） */
    readonly path: string;
    /** 每条新连接给一个 Link；返回的 detach 在断线时调用 */
    readonly onLink: (link: Link) => () => void;
    /** 坏帧 / socket 错误（诊断用；不参与业务） */
    readonly onError?: (err: Error) => void;
}

export interface Listening {
    readonly path: string;
    close(): Promise<void>;
}

/** 起一个 socket 监听端。**多连接**：每个连接一条独立链路（actor 可以同时被 CLI / UI / 兄弟节点连） */
export function listenSocket(opts: ListenOptions): Promise<Listening> {
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        const link = frameLink(socketText(socket), (message) => opts.onError?.(new Error(message)));
        const detach = opts.onLink(link);
        let closed = false;
        const done = () => {
            if (closed) return;
            closed = true;
            detach();
            sockets.delete(socket);
        };
        socket.on('close', done);
        socket.on('error', (err) => {
            opts.onError?.(err);
            socket.destroy();
            done();
        });
    });

    return new Promise<Listening>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(opts.path, () => {
            server.off('error', onError);
            server.on('error', (err) => opts.onError?.(err));
            resolve({
                path: opts.path,
                close: () =>
                    new Promise<void>((done) => {
                        for (const socket of sockets) socket.destroy();
                        sockets.clear();
                        server.close(() => done());
                    }),
            });
        });
    });
}

export interface DialedLink extends Link {
    close(): void;
}

/**
 * 连一个监听端。
 *
 * 两种失败要分清（docs/02「E_NOT_FOUND 专指收件人不存在」）：
 *   - socket 文件不在 ⇒ 地址错了（E_NOT_FOUND）；
 *   - 文件在但没人接 ⇒ 那个节点掉线了（E_UNAVAILABLE）。
 * 这个区分是「成员掉线仍显示在名单里」的前提，别合并成一个 code。
 */
export function dialSocket(path: string, opts: { timeoutMs?: number } = {}): Promise<DialedLink> {
    return new Promise<DialedLink>((resolve, reject) => {
        const socket = createConnection(path);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(codeError('E_TIMEOUT', `连 ${path} 超时 ${opts.timeoutMs ?? 5_000}ms`));
        }, opts.timeoutMs ?? 5_000);

        socket.once('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            const code = err.code === 'ENOENT' ? 'E_NOT_FOUND' : 'E_UNAVAILABLE';
            reject(codeError(code, `连 ${path} 失败：${err.code ?? err.message}`));
        });
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.on('error', () => socket.destroy());
            const link = frameLink(socketText(socket)) as DialedLink;
            link.close = () => socket.destroy();
            resolve(link);
        });
    });
}

function codeError(code: 'E_NOT_FOUND' | 'E_UNAVAILABLE' | 'E_TIMEOUT', message: string): Error {
    return Object.assign(new Error(message), { code });
}

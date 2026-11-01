// server.ts — apps/web 的服务端：**无 Electron**（判据 6）。
//
// 一张端口上干三件事：
//   ① `GET /ping`         —— 纯 HTTP GET，手写（用户裁决：简单，任何人能 curl 验证，不进 RPC）
//   ② 静态托管           —— index.html + renderer 打包产物（chat-page 的页面一行不改）
//   ③ WebSocket upgrade  —— 挂 @diy-agent/rpc 的 **ChannelServerBinding**（信封协议，
//                           与 diy-app 的 electron IPC 同一套；浏览器的 RPC 全走这里）
//
// 为什么浏览器不能走 HttpServerBinding：那套绑定是 `node:http2` 的（http-server-binding.ts
// 吃 ServerHttp2Stream，http-client-binding.ts 用 http2.connect），而浏览器不支持 **h2c**
// （明文 HTTP/2），本轮又不做 TLS（反代解决）—— 于是浏览器侧没有可用的 http 绑定。
// 同一份 router 挂到两种绑定上都成立（业务层不认识传输）：Node 客户端可走
// `startHttpRpc()`（HttpServerBinding + h2c），浏览器走 ws —— 换 binding 不改业务。

import http from 'node:http';
import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { extname, normalize, resolve } from 'node:path';
import { ChannelServerBinding } from '@diy-agent/rpc';
import { HttpServerBinding } from '@diy-agent/rpc/http';
import { WsTransport } from '@diy-agent/rpc/ws';
import { ensureIdentity } from '@diy-agent/remote/node';
import { WebSocketServer } from 'ws';
import { openAuthStore, authStorePath, type AuthCore } from './auth.js';
import { newWebRpcStats, registerWebApi, type WebPeer, type WebRpcStats } from './handlers.js';
import { createPagesHost, type PagesHost } from './pages.js';
import type { LlmPort } from '@diy-agent/session';

/** 应用短名（##484 的 displayAddress 里那一段，别用 `@diy-agent/app-web`） */
export const APP_NAME = 'diy-web';

/** 缺省端口（与 remote-shell 的 --url 示例一致） */
export const DEFAULT_PORT = 8080;

/** `GET /ping` 的响应（在 ##479 的 PingInfo 之上补 app / address / auth） */
export interface WebPingInfo {
    readonly id: string;
    readonly displayName: string;
    readonly app: string;
    readonly variant: string;
    readonly address: string;
    readonly version: string;
    readonly pid: number;
    readonly startedAt: string;
    readonly uptimeMs: number;
    /** 本轮：除 /ping 与 /auth 之外的一切能力都要 token */
    readonly auth: 'required';
}

export interface WebServerOptions {
    /** 监听端口；0 = 随机（测试用）。缺省 DEFAULT_PORT */
    readonly port?: number;
    /** 绑定地址；缺省 127.0.0.1（跨机要显式给内网地址） */
    readonly host?: string;
    /** 数据根（`$DIY_HOME`）：授权 store / 会话 / 模型配置都在它下面 */
    readonly home: string;
    /** 静态产物目录（index.html + renderer/index.js）；缺省由调用方给 */
    readonly staticDir: string;
    /** 变体（prod / lab / test）——只用于身份地址与 /ping；缺省 `DIY_VARIANT` 或 lab */
    readonly variant?: string;
    /** 测试注入假 LLM；生产不传（真 provider，key 从 model.yaml 账号表取） */
    readonly llmFor?: (modelKey: string) => LlmPort;
    /**
     * 额外的 **h2c** RPC 端口（HttpServerBinding）：给 Node 客户端（CLI / 别的 diy 实例用，
     * 浏览器的 WebSocket 不需要它）。0 / 不传 = 不起。同一份 router、同一份授权状态。
     */
    readonly httpRpcPort?: number;
}

export interface WebServerHandle {
    /** `http://<host>:<port>` */
    readonly url: string;
    readonly port: number;
    /** 起了 h2c 端口时给出（否则 null） */
    readonly httpRpcPort: number | null;
    readonly ping: () => WebPingInfo;
    readonly auth: AuthCore;
    readonly pages: PagesHost;
    readonly stats: WebRpcStats;
    close(): Promise<void>;
}

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

/** 身份地址（##484 的格式：`user@host/app.variant`）。##484 合入后换成它的 formatAddress() */
export function displayAddress(input: {
    readonly user: string;
    readonly host: string;
    readonly app?: string;
    readonly variant: string;
}): string {
    return `${input.user}@${input.host}/${input.app ?? APP_NAME}.${input.variant}`;
}

/** 对端是否回环（副方管理面的唯一判据） */
export function isLoopback(address: string | undefined): boolean {
    if (address === undefined) return false;
    const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function peerOf(address: string | undefined, fallback: string): WebPeer {
    const raw = address ?? fallback;
    return { address: raw, loopback: isLoopback(raw) };
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? '127.0.0.1';
    const variant = options.variant ?? process.env['DIY_VARIANT'] ?? 'lab';

    // 身份：`$DIY_HOME/instance-id` 由 ##479 落盘，重启不变（别拿 hostname 当 id）
    const identity = ensureIdentity(options.home);
    const startedAt = new Date().toISOString();
    const address = displayAddress({
        user: userInfo().username,
        host: identity.identity.displayName,
        variant,
    });

    const auth = await openAuthStore(authStorePath(options.home), {
        now: () => new Date(),
        newId: () => randomUUID(),
        newToken: () => `diyweb_${randomUUID().replace(/-/g, '')}`,
    });
    const pages = await createPagesHost(
        options.llmFor === undefined ? { home: options.home } : { home: options.home, llmFor: options.llmFor },
    );
    const stats = newWebRpcStats();
    const rpcDeps = { auth, pages, address, stats } as const;

    const ping = (): WebPingInfo => ({
        id: identity.identity.id,
        displayName: identity.identity.displayName,
        app: APP_NAME,
        variant,
        address,
        version: '0.1.0',
        pid: process.pid,
        startedAt,
        uptimeMs: Date.now() - Date.parse(startedAt),
        auth: 'required',
    });

    // ── HTTP：/ping（手写）+ 静态托管 + WebSocket upgrade ──────────────
    const server = http.createServer((req, res) => {
        void handleHttp(req, res).catch((cause: unknown) => {
            console.error('[web] 请求处理失败', cause);
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'INTERNAL', message: String(cause) }));
        });
    });

    const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
        if (url.pathname === '/ping') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
            }
            const body = JSON.stringify(ping(), null, 4);
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
        }
        await serveStatic(options.staticDir, url.pathname, req, res);
    };

    const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
        // 只接 WebSocket：别的一律 400（别让半截 upgrade 挂在那里）
        if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const peer = peerOf(req.socket.remoteAddress, host);
            const binding = new ChannelServerBinding(new WsTransport(ws));
            registerWebApi(binding, peer, rpcDeps);
            ws.on('close', () => binding.destroy());
        });
    });

    await listen(server, port, host);
    const actualPort = (server.address() as { port: number }).port;

    // ── 可选的 h2c RPC 端口：同一份 router 挂到 HttpServerBinding（Node 客户端）──
    //
    // 一张 http 绑定 = 一个逻辑连接（http 绑定没有连接上下文，handler 拿不到 peer）：
    // 客户端在同一个 h2 会话上先 login 再 page.*，与 ws 的连接语义一致。
    // peer 取监听地址 —— h2c 只在本机可达（跨机用 ws）。
    let httpRpcServer: http2.Http2Server | null = null;
    let httpRpcPort: number | null = null;
    if (options.httpRpcPort !== undefined && options.httpRpcPort > 0) {
        const httpBinding = new HttpServerBinding();
        registerWebApi(httpBinding, peerOf(host, host), rpcDeps);
        httpRpcServer = http2.createServer();
        httpRpcServer.on('stream', (stream, headers) => {
            // node 的 'stream' 事件给的是 Http2Stream，绑定的签名要 ServerHttp2Stream（同一对象）
            void httpBinding.handleStream(stream as http2.ServerHttp2Stream, headers);
        });
        await listen(httpRpcServer, options.httpRpcPort, host);
        httpRpcPort = (httpRpcServer.address() as { port: number }).port;
    }

    return {
        url: `http://${host}:${actualPort}`,
        port: actualPort,
        httpRpcPort,
        ping,
        auth,
        pages,
        stats,
        async close(): Promise<void> {
            for (const client of wss.clients) client.close();
            wss.close();
            await new Promise<void>((done) => httpRpcServer?.close(() => done()) ?? done());
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

async function listen(server: http.Server | http2.Http2Server, port: number, host: string): Promise<void> {
    await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
            server.removeListener('error', fail);
            done();
        });
    });
}

/** 静态托管：只认 staticDir 之下的文件（`..` 逃逸一律 404） */
async function serveStatic(
    root: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
    }
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(
        /^([/\\])+/,
        '',
    );
    const target = resolve(root, relative);
    if (!target.startsWith(resolve(root))) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: `不在静态根之下：${pathname}` }));
        return;
    }
    let size: number;
    try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error('not a file');
        size = info.size;
    } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: pathname }));
        return;
    }
    res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'content-length': String(size),
        'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    await new Promise<void>((done, fail) => {
        const stream = createReadStream(target);
        stream.on('error', fail);
        stream.on('end', () => done());
        stream.pipe(res);
    });
}

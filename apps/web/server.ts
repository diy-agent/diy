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
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { extname, normalize, resolve } from 'node:path';
import { ChannelServerBinding } from '@diy-agent/rpc';
import { HttpServerBinding } from '@diy-agent/rpc/http';
import { WsTransport } from '@diy-agent/rpc/ws';
import { tryFormatAddress, type DiscoveredInstance } from '@diy-agent/remote';
import { ensureIdentity, localDiscoverer } from '@diy-agent/remote/node';
import {
    isOwnRecordFile,
    localISOString,
    registryDir,
    repoRootOf,
    removeRecord,
    snapshotParents,
    updateRecord,
    writeRecord,
    type WebInstanceRecord,
} from './registry.js';
import { WebSocketServer } from 'ws';
import { openAuthStore, authStorePath, type AuthCore } from './auth.js';
import { newWebRpcStats, registerWebApi, type WebPeer, type WebRpcStats } from './handlers.js';
import { createPagesHost, type PagesHost } from './pages.js';
import {
    clearSessionCookie,
    contextFromRequest,
    defaultUsername,
    defaultWebAuthnDeps,
    openWebAuthnStore,
    parseCookies,
    sessionCookie,
    SESSION_COOKIE,
    webauthnStorePath,
    type WebAuthnCore,
} from './webauthn.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
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
    /**
     * 部署前缀（如 `/diy`）：反代把 `https://host/diy/*` **原样**转进来时用它剥前缀。
     * 缺省读 `DIY_WEB_BASE_PATH`，再缺省 `''`（= 挂在根上）。
     */
    readonly basePath?: string;
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
    /** 部署前缀（`''` = 挂在根上） */
    readonly basePath: string;
    readonly port: number;
    /** 起了 h2c 端口时给出（否则 null） */
    readonly httpRpcPort: number | null;
    readonly ping: () => WebPingInfo;
    readonly auth: AuthCore;
    /** Passkey（##496）内核：注册 / 登录 / 会话 */
    readonly webauthn: WebAuthnCore;
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

/** 地址多久重算一次（超出就重扫）：定死会漏掉「同格第二台」（判据 1） */
const ADDRESS_TTL_MS = 2000;

/** 本机实例扫描：跳过自己那条（自己 ping 自己既浪费又可能跨实例递归成立） */
const addressDiscoverer = localDiscoverer({
    timeoutMs: 300,
    readFile: (file) => (isOwnRecordFile(file) ? null : readFileOrNull(file)),
});

function readFileOrNull(file: string): string | null {
    try {
        return readFileSync(file, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * 身份地址（##484 的规则）：默认 `user@host/app.variant`；**同格**（本机还有 app+variant 相同的
 * 实例）时带端口才分得清。
 *
 * 冲突判据走 local 发现器（注册表 + /ping 探活），而不是「读注册表就当数」——进程卡死 / 端口已关
 * 的旧条目不该让地址凭空多出端口。拼不出来（显示名含保留字符）退回 `user@host`，不抛。
 */
async function resolveAddress(input: {
    readonly user: string;
    readonly host: string;
    readonly variant: string;
    readonly port: number;
}): Promise<string> {
    let peers: DiscoveredInstance[] = [];
    try {
        peers = await addressDiscoverer.discover();
    } catch {
        /* 扫不到别人不是错：当作「本机只有我」，地址不带端口 */
    }
    const clash = peers.some((peer) => peer.meta?.['app'] === APP_NAME && peer.meta?.['variant'] === input.variant);
    const address = tryFormatAddress({
        user: input.user,
        host: input.host,
        app: APP_NAME,
        variant: input.variant,
        ...(clash ? { port: input.port } : {}),
    });
    return address ?? `${input.user}@${input.host}`;
}

/** 部署前缀归一：`/diy/` / `diy` / `` ⇒ `/diy` / `/diy` / `` */
function normalizeBase(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/') return '';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** 剥掉部署前缀；不在前缀之下返回 null（= 404，不把别人家的路径当成自己的） */
function stripBase(pathname: string, base: string): string | null {
    if (base === '') return pathname;
    if (pathname === base) return '/';
    if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
    return null;
}

/** 对端是否回环（副方管理面的唯一判据） */
export function isLoopback(address: string | undefined): boolean {
    if (address === undefined) return false;
    const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

/** 建连请求的 HTTP 头：Passkey 要从这里推 rpID / origin，并读会话 cookie */
function peerOf(address: string | undefined, fallback: string, headers?: http.IncomingHttpHeaders): WebPeer {
    const raw = address ?? fallback;
    const host = headers?.host;
    const cookie = headers?.cookie;
    const forwardedProto = headerOf(headers?.['x-forwarded-proto']);
    return {
        address: raw,
        loopback: isLoopback(raw),
        ...(host === undefined ? {} : { host }),
        ...(cookie === undefined ? {} : { cookie }),
        ...(forwardedProto === undefined ? {} : { forwardedProto }),
    };
}

/**
 * 回环 IP 打开的页面重定向到 `localhost`（WebAuthn 不接受 IP 当 RP ID）。
 *
 * 只对「人打开的页面」生效：GET + Accept 含 `text/html`。机器接口（`/ping`）/ RPC / `/webauthn/*`
 * 都是 JSON 或 fetch 请求，不满足条件 —— 不让重定向影响 remote 壳发现与命令行调用。
 *
 * @returns 重定向目标（同路径 + 查询串，只换 host）；不需要重定向 = null
 */
export function loopbackPageRedirect(req: http.IncomingMessage): string | null {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    if (!(headerOf(req.headers.accept) ?? '').includes('text/html')) return null;
    const hostHeader = req.headers.host ?? '';
    if (hostHeader === '') return null;
    // 用 URL 解析拿主机名 / 端口：`[::1]:8080` 这种方括号写法也吃
    let parsed: URL;
    try {
        parsed = new URL(`http://${hostHeader}`);
    } catch {
        return null;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const loopbackIp = hostname === '::1' || hostname === '127.0.0.1' || hostname.startsWith('127.');
    if (!loopbackIp) return null;
    const port = parsed.port === '' ? '' : `:${parsed.port}`;
    return `http://localhost${port}${req.url ?? '/'}`;
}

/** 头字段可能是 string / string[] / undefined（Node 的类型），统一取 string */
function headerOf(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[0] : value;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? '127.0.0.1';
    const variant = options.variant ?? process.env['DIY_VARIANT'] ?? 'lab';
    const basePath = normalizeBase(options.basePath ?? process.env['DIY_WEB_BASE_PATH'] ?? '');

    // 身份：`$DIY_HOME/instance-id` 由 ##479 落盘，重启不变（别拿 hostname 当 id）
    const identity = ensureIdentity(options.home);
    const startedAt = new Date().toISOString();
    const selfPid = process.pid;

    // ── 自报注册表 + 地址（##495）：启动/退出写/删 `~/.diy-instances/<pid>.json` ──
    // 端口要 listen 之后才知道，故记录在 listen 后写（web 没有 diy-app 那种「先写 null 再回填」的必要）。
    const recordsDir = registryDir();
    let listeningPort = port;
    let address = `${userInfo().username}@${identity.identity.displayName}`;
    let addressAt = 0;
    let addressRefresh: Promise<void> | null = null;
    let addressSignature = '';

    /** 注册表目录的「名单签名」：别的实例起来 / 退出 = 名单变 = 地址必须重算（不等 TTL） */
    const registrySignature = (): string => {
        try {
            return readdirSync(recordsDir).sort().join(',');
        } catch {
            return '';
        }
    };

    const refreshAddress = (): Promise<void> => {
        // 已有一次在跑：**立刻用旧值返回**，不排队等它 —— 否则跨实例互 ping 会等到超时（环）
        if (addressRefresh !== null) return Promise.resolve();
        const signature = registrySignature();
        const changed = signature !== addressSignature;
        if (!changed && Date.now() - addressAt < ADDRESS_TTL_MS) return Promise.resolve();
        addressRefresh = (async () => {
            try {
                address = await resolveAddress({
                    user: userInfo().username,
                    host: identity.identity.displayName,
                    variant,
                    port: listeningPort,
                });
                updateRecord(recordsDir, selfPid, { address });
            } catch {
                /* 算不出来就保留上一次的 —— /ping 永远有东西可答 */
            } finally {
                addressAt = Date.now();
                addressSignature = registrySignature();
                addressRefresh = null;
            }
        })();
        return addressRefresh;
    };

    const dropSelfRecord = (): void => removeRecord(recordsDir, selfPid);
    process.once('exit', dropSelfRecord);

    const auth = await openAuthStore(authStorePath(options.home), {
        now: () => new Date(),
        newId: () => randomUUID(),
        newToken: () => `diyweb_${randomUUID().replace(/-/g, '')}`,
    });
    // Passkey（##496）：用户 / 公钥落 `$DIY_HOME/web/users.json`；challenge 与会话只在内存
    const webauthn = await openWebAuthnStore(webauthnStorePath(options.home), defaultWebAuthnDeps());
    const pages = await createPagesHost(
        options.llmFor === undefined ? { home: options.home } : { home: options.home, llmFor: options.llmFor },
    );
    const stats = newWebRpcStats();
    // getter：连接建立时才读当前地址（多实例带入端口是后来才成立的）
    const rpcDeps = {
        auth,
        webauthn,
        pages,
        stats,
        get address(): string {
            return address;
        },
    };

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
        // 回环 IP 打开的**页面**一律 302 到 `localhost`（2026-11-02 实测挡路）。
        // 原因：WebAuthn 的 RP ID 从 Host 推，而 `127.0.0.1` / `::1` 是 IP 字面量 ——
        // 规范不允许 IP 当 RP ID，浏览器直接报 `127.0.0.1 is an invalid domain`（passkey 创建失败）。
        // 换到 `localhost` 后 rpID/origin 合法；同一台机器的多个实例还能共用同一个 RP ID。
        // 只重定向**页面导航**（GET + Accept 含 text/html）：`/ping` 等机器接口与 `/webauthn/*` 不受影响。
        const redirectTo = loopbackPageRedirect(req);
        if (redirectTo !== null) {
            res.writeHead(302, { location: redirectTo });
            res.end();
            return;
        }
        // 部署前缀（`/diy`）：反代把 `https://host/diy/*` 原样转进来（tailscale serve 不剥前缀），
        // 这里剥掉再路由 —— 否则 `/diy/ping` 会被当成静态文件 404。前缀为空时什么也不做。
        const pathname = stripBase(url.pathname, basePath);
        if (pathname === null) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: `不在部署前缀 ${basePath} 之下：${url.pathname}` }));
            return;
        }
        if (pathname === '/ping') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
            }
            // 地址现算：同格第二台可能刚起来 / 刚退出（判据 1/2）
            await refreshAddress();
            const body = JSON.stringify(ping(), null, 4);
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
        }
        if (pathname === '/webauthn' || pathname.startsWith('/webauthn/')) {
            await handleWebAuthn(req, res, pathname);
            return;
        }
        // 目录没带尾斜杠（`/diy`）⇒ 补一个：页面的相对资源（`./index.js`）靠它才能解析对
        const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
        if (!pathname.endsWith('/') && !lastSegment.includes('.')) {
            res.writeHead(302, { location: `${pathname}/${url.search}` });
            res.end();
            return;
        }
        await serveStatic(options.staticDir, pathname, req, res);
    };

    // ── Passkey（##496）：HTTP 面 ────────────────────────────────────
    //
    // 为什么这几条是 HTTP 路由而不是 RPC 方法：**HttpOnly cookie 只能由 HTTP 响应的
    // `Set-Cookie` 下发**（WebSocket 升级响应带不了）。业务逻辑一行都不在这几段里 —— 全部转手给
    // webauthn.ts（同一份内核也挂在 `web.webauthn.*` 上，给 Node 客户端用）。
    //
    // 路由与 api.ts 的方法一一对应：
    //   GET  /webauthn/me                ↔ web.webauthn.me
    //   POST /webauthn/register/options  ↔ web.webauthn.register.options
    //   POST /webauthn/register/verify   ↔ web.webauthn.register.verify
    //   POST /webauthn/login/options     ↔ web.webauthn.login.options
    //   POST /webauthn/login/verify      ↔ web.webauthn.login.verify（成功时 Set-Cookie）
    //   POST /webauthn/logout            ↔ web.webauthn.logout（清 cookie）

    const handleWebAuthn = async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        pathname: string,
    ): Promise<void> => {
        const route = pathname.replace(/^\/webauthn\/?/, '');
        const method = req.method ?? 'GET';
        const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
            res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                ...headers,
            });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
        };

        let context;
        try {
            context = contextFromRequest({
                host: req.headers.host,
                forwardedProto: headerOf(req.headers['x-forwarded-proto']),
            });
        } catch (cause) {
            reply(400, { error: 'INVALID_ARGUMENT', message: String(cause) });
            return;
        }
        const secure = context.origin.startsWith('https://');
        const sessionId = (): string | null => parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;

        // CSRF：写操作必须同源。浏览器一定会带 Origin；非浏览器客户端（curl / 测试）不带 ⇒ 放行
        if (method !== 'GET' && method !== 'HEAD') {
            const origin = req.headers.origin;
            if (origin !== undefined && origin !== context.origin) {
                reply(403, { error: 'PERMISSION_DENIED', message: `Origin 与本服务的 origin 不一致：${origin}` });
                return;
            }
        }

        try {
            if (route === 'me') {
                if (method !== 'GET' && method !== 'HEAD') {
                    reply(405, { error: 'METHOD_NOT_ALLOWED', message: 'me 只接受 GET' }, { allow: 'GET, HEAD' });
                    return;
                }
                reply(200, {
                    hasUser: webauthn.hasUser(),
                    user: webauthn.userOfSession(sessionId()),
                    rpID: context.rpID,
                    // 还没用户时给页面一个默认用户名（= 系统用户名，不写死 'owner'）
                    suggestedUsername: webauthn.hasUser() ? null : defaultUsername(),
                });
                return;
            }

            if (method !== 'POST') {
                reply(405, { error: 'METHOD_NOT_ALLOWED', message: `${route} 只接受 POST` }, { allow: 'POST' });
                return;
            }

            if (route === 'register/options') {
                const body = await readJsonBody(req);
                const username = typeof body['username'] === 'string' ? body['username'] : undefined;
                const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : undefined;
                const created = await webauthn.registrationOptions({
                    context,
                    ...(username === undefined ? {} : { username }),
                    ...(displayName === undefined ? {} : { displayName }),
                });
                reply(200, { options: created.options });
                return;
            }

            if (route === 'register/verify') {
                // 创建成功**不发会话**：判据 2/4 —— 页面显示「已创建」，刷新后仍是「用 Passkey 登录」
                const body = await readJsonBody(req);
                const response = requireResponse<RegistrationResponseJSON>(body, 'registration');
                const created = await webauthn.verifyRegistration({ context, response });
                await webauthn.flush();
                reply(200, created);
                return;
            }

            if (route === 'login/options') {
                const created = await webauthn.authenticationOptions({ context });
                reply(200, { options: created.options });
                return;
            }

            if (route === 'login/verify') {
                const body = await readJsonBody(req);
                const response = requireResponse<AuthenticationResponseJSON>(body, 'authentication');
                const result = await webauthn.verifyAuthentication({ context, response });
                await webauthn.flush();
                console.info(`[web] Passkey 登录成功：${result.user.id}`);
                reply(
                    200,
                    { user: result.user, expiresAt: result.expiresAt },
                    {
                        'set-cookie': sessionCookie(result.sessionId, {
                            secure,
                            // ceil：过期时刻与「现在」差几毫秒，floor 会写出 604799（差一秒也是差）
                            maxAgeMs: Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000) * 1000),
                        }),
                    },
                );
                return;
            }

            if (route === 'logout') {
                webauthn.logout(sessionId());
                reply(200, { ok: true }, { 'set-cookie': clearSessionCookie({ secure }) });
                return;
            }

            reply(404, { error: 'NOT_FOUND', message: `没有这条 Passkey 路由：${pathname}` });
        } catch (cause) {
            const code = (cause as { code?: unknown }).code;
            const status =
                code === 'FAILED_PRECONDITION' || code === 'INVALID_ARGUMENT'
                    ? 400
                    : code === 'UNAUTHENTICATED'
                      ? 401
                      : code === 'NOT_FOUND'
                        ? 404
                        : code === 'PERMISSION_DENIED'
                          ? 403
                          : 500;
            const message = cause instanceof Error ? cause.message : String(cause);
            if (status >= 500) console.error('[web] Passkey 处理失败', cause);
            else console.warn(`[web] Passkey 请求被拒（${pathname}）：${message}`);
            reply(status, { error: typeof code === 'string' ? code : 'INTERNAL', message });
        }
    };

    const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
        // 只接 WebSocket：别的一律 400（别让半截 upgrade 挂在那里）
        if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            // 建连请求的头一起带进去：Passkey 要从 Host 推 rpID/origin、从 Cookie 读会话
            const peer = peerOf(req.socket.remoteAddress, host, req.headers);
            const binding = new ChannelServerBinding(new WsTransport(ws));
            registerWebApi(binding, peer, rpcDeps);
            ws.on('close', () => binding.destroy());
        });
    });

    await listen(server, port, host);
    const actualPort = (server.address() as { port: number }).port;
    listeningPort = actualPort;

    // 就绪后自报：此时「要不要带端口」还不确定，先写基础形态，refreshAddress 会回填
    const selfRecord: WebInstanceRecord = {
        pid: selfPid,
        port: actualPort,
        pingPort: actualPort,
        diyHome: options.home,
        variant,
        env: process.env['DIY_ENV'] ?? 'production',
        argv: [...process.argv],
        cwd: process.cwd(),
        startedAt,
        updatedAt: localISOString(),
        parents: snapshotParents(),
        app: APP_NAME,
        // ##502 第二轮：launch = app.yaml 里那条启动命令（dev 启动器注入 DIY_LAUNCH）；
        // 手工跑没有 env，就按实际端口回推（app.yaml 里 launch id 是 `web-<port>`）
        launch: process.env['DIY_LAUNCH'] ?? `web-${actualPort}`,
        worktree: repoRootOf(),
        address,
    };
    writeRecord(recordsDir, selfRecord);
    await refreshAddress();

    // ── 可选的 h2c RPC 端口：同一份 router 挂到 HttpServerBinding（Node 客户端）──
    //
    // 一张 http 绑定 = 一个逻辑连接（http 绑定没有连接上下文，handler 拿不到 peer）：
    // 客户端在同一个 h2 会话上先 login 再 page.*，与 ws 的连接语义一致。
    // peer 取监听地址 —— h2c 只在本机可达（跨机用 ws）。
    let httpRpcServer: http2.Http2Server | null = null;
    let httpRpcPort: number | null = null;
    if (options.httpRpcPort !== undefined && options.httpRpcPort > 0) {
        const httpBinding = new HttpServerBinding();
        registerWebApi(httpBinding, peerOf(host, host, { host: `${host}:${options.httpRpcPort}` }), rpcDeps);
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
        basePath,
        port: actualPort,
        httpRpcPort,
        ping,
        auth,
        webauthn,
        pages,
        stats,
        async close(): Promise<void> {
            process.removeListener('exit', dropSelfRecord);
            dropSelfRecord();
            for (const client of wss.clients) client.close();
            wss.close();
            await new Promise<void>((done) => httpRpcServer?.close(() => done()) ?? done());
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

/** `{ response: <WebAuthn 响应> }` 里取出来（和 api.ts 的 input 同形）；缺了就是 400 不是 500 */
function requireResponse<T>(body: Record<string, unknown>, label: string): T {
    const value = body['response'];
    if (value === null || typeof value !== 'object') {
        throw Object.assign(new Error(`请求体缺少 response（${label} 响应对象）`), { code: 'INVALID_ARGUMENT' });
    }
    return value as T;
}

/** 读 JSON 请求体（上限 256 KB：WebAuthn 响应的量级是 KB，不是 MB） */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const MAX_BYTES = 256 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BYTES) {
            throw Object.assign(new Error(`请求体过大（> ${MAX_BYTES} 字节）`), { code: 'INVALID_ARGUMENT' });
        }
        chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw === '') return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('不是 JSON 对象');
        }
        return parsed as Record<string, unknown>;
    } catch (cause) {
        throw Object.assign(new Error(`请求体不是合法 JSON：${String(cause)}`), { code: 'INVALID_ARGUMENT' });
    }
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

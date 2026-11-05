// Hub 侧：`/hub/info`（公开身份）+ `/hub/pair`（唯一出现邀请码的入口）+ WSS 接入。
//
// 安全边界：
//   · `/hub/info` 不含任何秘密，卫星据此核对指纹（判据 6 的前半）
//   · `/hub/pair` 只在**人已经核对过指纹**之后才被卫星调用（客户端强制，见 client.ts）
//   · WSS 只认 `Authorization: Bearer <token>`；撤销后现有连接断开、重连 403（判据 17/18）
//
// 传输：默认必须 TLS（判据 8），明文只允许显式 `allowInsecureHttp`（单测用）。

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createInvitation, type InvitationOptions } from './invitation.js';
import { sha256Hex, safeEqualHex } from './key.js';
import { HubError, isHubError } from './errors.js';
import {
    approveRequest,
    listMemberships,
    listPendingRequests,
    rejectRequest,
    revokeMembership,
    submitPairingRequest,
    type ApprovalResult,
    type PairingOptions,
} from './pairing.js';
import type { HubStore } from './store.js';
import { assertTransportSecurity, isTrustedBindHost, type TlsMaterial } from './tls.js';
import {
    HUB_PROTOCOL_VERSION,
    type HubIdentity,
    type HubInfo,
    type Membership,
    type PairRequestBody,
    type PairSuccess,
    type PairingRequest,
} from './types.js';

/** 公共 API 的协议标识（与配对协议 HUB_PROTOCOL_VERSION 分开：连接 ≠ 授权） */
const NODE_PROTOCOL = 'diy-node/1';

/**
 * URL 路径 → 路由路径。
 *
 * `tailscale serve --set-path <x>` 不剥前缀，所以外部是 `/<x>/info`；
 * 而直连后端是 `/info`。这里统一剥掉我们自己那一层，两种形状落到同一组路由上。
 * 老的 `/hub` 前缀（endpoint 直接写 `https://host/hub`）**保持向后兼容**：
 * 没有配 basePath 时它就是普通路径，`/hub/info` 原样命中。
 */
function routePathOf(raw: string, basePath: string | undefined): string {
    // ① 反向代理（tailscale serve --set-path）指定的前缀：剥掉它是我们的事
    if (basePath !== undefined && basePath !== '') {
        const prefix = `/${basePath.replace(/^\/+|\/+$/g, '')}`;
        if (raw === prefix) return '/';
        if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length);
        return raw;
    }
    // ② 没有代理前缀：`hub.url` 自带 `/hub` 挂载点（历史形状，也是本包默认对外路径）
    return raw.replace(/^\/hub(?=\/)/, '');
}

const MAX_BODY_BYTES = 64 * 1024;
const WS_PATH = '/ws';

export interface HubServerOptions {
    identity: HubIdentity;
    store: HubStore;
    /** HMAC / 签发密钥（Hub 私钥；只在内存） */
    serverKey: string;
    tls?: TlsMaterial | null;
    /**
     * 反向代理挂载的前缀（`tailscale serve --set-path diy-app-lab` ⇒ `'diy-app-lab'`）。
     * serve **不剥前缀**（`/hub/info` 实测会被剥，但 `--set-path` 的行为不保证），
     * 所以由我们自己剥：剥掉之后路由就是规格里那几条，和直连完全一致。
     */
    basePath?: string;
    /**
     * **只给单测**：显式允许明文。生产不要用这个 —— 它会让「门开在 0.0.0.0」也放行。
     * 真正的判据是 `host` 是否在可信网络里（见 tls.ts 的 isTrustedBindHost）。
     */
    allowInsecureHttp?: boolean;
    host?: string;
    port?: number;
    now?: () => Date;
    tokenFactory?: () => string;
    randomId?: (prefix: string) => string;
}

export interface HubServer {
    readonly info: HubInfo;
    readonly port: number;
    readonly url: string;
    invite(opts?: { ttlMs?: number; autoApprove?: boolean; protocol?: 'code' | 'pinned-key' }): Promise<{ inviteId: string; code: string; expiresAt: string }>;
    pair(body: PairRequestBody): Promise<PairSuccess>;
    pending(): Promise<PairingRequest[]>;
    approve(requestId: string): Promise<ApprovalResult>;
    reject(requestId: string): Promise<PairingRequest>;
    revoke(nodeId: string): Promise<Membership>;
    memberships(): Promise<Membership[]>;
    connectionCount(nodeId?: string): number;
    close(): Promise<void>;
}

export async function createHubServer(opts: HubServerOptions): Promise<HubServer> {
    assertTransportSecurity(opts.tls, opts.host);
    if (opts.allowInsecureHttp === true && !isTrustedBindHost(opts.host)) {
        // 单测逃生口仍然只在不可信地址上「不够用」时才需要显式提醒
        console.warn('[hub] allowInsecureHttp 在不可信地址上被忽略（判据 8）');
    }

    const now = opts.now ?? (() => new Date());
    const pairingOpts: PairingOptions = {
        serverKey: opts.serverKey,
        now,
        tokenFactory: opts.tokenFactory,
        randomId: opts.randomId,
    };
    const invitationOpts: InvitationOptions & { domainId: string; hubNodeId: string } = {
        serverKey: opts.serverKey,
        now,
        randomId: opts.randomId,
        domainId: opts.identity.domainId,
        hubNodeId: opts.identity.hubNodeId,
    };

    const info: HubInfo = {
        protocolVersion: HUB_PROTOCOL_VERSION,
        domainId: opts.identity.domainId,
        hubNodeId: opts.identity.hubNodeId,
        hubPublicKey: opts.identity.publicKey,
    };

    /**
     * `GET /info` 的响应：**只有「我活着、我说这个协议」**。
     *
     * 刻意不含 domainId / hubNodeId / publicKey —— 那些是「我是谁」，属于配对域。
     * 未建立关系的对端只需要知道「能不能通」，不需要知道对面是谁。
     */
    const publicInfo = { ok: true, protocol: NODE_PROTOCOL } as const;

    const waiters = new Map<string, (result: PairSuccess) => void>();
    const sockets = new Map<string, Set<WebSocket>>();

    const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
            const path = routePathOf(url.pathname, opts.basePath);

            // ── 公共 API（未授权也能访问）：只证明「我在」 ──
            // 判据（2026-11-05 用户裁）：还没建立附属关系时，暴露越少越好 ——
            // 这就是 ping 的语义：能安全交换消息，不代表我信任你。
            if (req.method === 'GET' && path === '/ping') {
                return json(res, 200, { ok: true, protocol: NODE_PROTOCOL });
            }
            if (req.method === 'GET' && path === '/info') {
                return json(res, 200, publicInfo);
            }
            // ── 配对域（协议信息）：`/protocol` ──
            // 为什么不叫 `/hub/info`：剥前缀后它会变成 `/info`，和上面那条最小探针撞车
            // （老形状 base 自带 `/hub`，剥完正好是 `/info`）。换个不重叠的名字最省事。
            if (req.method === 'GET' && path === '/protocol') {
                return json(res, 200, info);
            }
            if (req.method === 'POST' && path === '/pair') {
                const body = await readJsonBody<PairRequestBody>(req);
                if (body.protocolVersion !== HUB_PROTOCOL_VERSION) {
                    return json(res, 400, { error: 'hub/protocol-mismatch', message: '协议版本不一致' });
                }
                const created = await submitPairingRequest(opts.store, pairingOpts, body);
                // ##一键连接：邀请自带授权 ⇒ 立即批准，不走 pending、人也不用点同意。
                // 前提是邀请被标记 autoApprove（链接本身就是凭证，60 秒有效）。
                const state = await opts.store.read();
                const inv = state.invitations.find((i) => i.inviteId === body.inviteId);
                if (inv?.autoApprove === true && created.status === 'pending') {
                    const r = await approveRequest(opts.store, created.requestId, pairingOpts);
                    return json(res, 200, {
                        status: 'approved',
                        requestId: created.requestId,
                        token: r.token,
                        nodeId: r.membership.nodeId,
                        displayName: r.membership.displayName,
                    });
                }
                if (!body.waitMs || body.waitMs <= 0) {
                    return json(res, 200, created);
                }
                // 长轮询：等 Owner 批准（token 只在批准后回这一次）
                const approved = await waitForApproval(created.requestId, body.waitMs, waiters);
                return json(res, 200, approved);
            }
            return json(res, 404, { error: 'hub/not-found', message: '未知路径' });
        } catch (e) {
            return sendError(res, e);
        }
    };

    const server: Server = opts.tls
        ? createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }, (req, res) => void requestHandler(req, res))
        : createHttpServer((req, res) => void requestHandler(req, res));

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (routePathOf(url.pathname, opts.basePath) !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');

        const token = bearerToken(req.headers.authorization);
        const header = token ? sha256Hex(token) : '';
        void opts.store.read().then((state) => {
            const matched = token ? state.memberships.find((m) => safeEqualHex(m.tokenHash, header)) : undefined;
            if (!matched) return rejectUpgrade(socket, 401, 'Unauthorized');
            // 判据 18：撤销后重连一律 403
            if (matched.status !== 'active') return rejectUpgrade(socket, 403, 'Forbidden');

            wss.handleUpgrade(req, socket, head, (ws) => {
                bindSocket(ws, matched.nodeId);
            });
        });
    });

    function bindSocket(ws: WebSocket, nodeId: string): void {
        let set = sockets.get(nodeId);
        if (!set) {
            set = new Set();
            sockets.set(nodeId, set);
        }
        set.add(ws);
        ws.on('message', (raw) => {
            let msg: { type?: string } = {};
            try {
                msg = JSON.parse(String(raw)) as { type?: string };
            } catch {
                /* 忽略非 JSON */
            }
            if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: now().getTime() }));
        });
        ws.on('close', () => {
            set!.delete(ws);
            if (set!.size === 0) sockets.delete(nodeId);
        });
    }

    await new Promise<void>((resolve) => {
        server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
    const scheme = opts.tls ? 'https' : 'http';
    const host = opts.host ?? '127.0.0.1';
    const url = `${scheme}://${host}:${port}`;

    const handle: HubServer = {
        info,
        port,
        url,
        async invite(inviteOpts) {
            // ##一键连接：autoApprove 时把有效期压到 60 秒（链接即凭证，越短越安全）
            const auto = inviteOpts?.autoApprove === true;
            const protocol = inviteOpts?.protocol === 'pinned-key' ? 'pinned-key' : undefined;
            const created = await createInvitation(opts.store, {
                ...invitationOpts,
                ttlMs: inviteOpts?.ttlMs ?? (auto ? 60_000 : undefined),
                ...(auto ? { autoApprove: true } : {}),
                ...(protocol ? { protocol } : {}),
            });
            return {
                inviteId: created.invitation.inviteId,
                code: created.code,
                expiresAt: created.invitation.expiresAt,
            };
        },
        async pair(body) {
            return submitPairingRequest(opts.store, pairingOpts, body);
        },
        pending: () => listPendingRequests(opts.store),
        async approve(requestId) {
            const result = await approveRequest(opts.store, requestId, pairingOpts);
            const waiter = waiters.get(requestId);
            if (waiter) {
                waiters.delete(requestId);
                waiter({
                    status: 'approved',
                    requestId,
                    token: result.token,
                    membershipId: result.membership.membershipId,
                });
            }
            return result;
        },
        reject: (requestId) => rejectRequest(opts.store, requestId, { now }),
        async revoke(nodeId) {
            const membership = await revokeMembership(
                opts.store,
                { nodeId, domainId: opts.identity.domainId },
                { now },
            );
            // 判据 17：现有连接立刻断开
            for (const ws of sockets.get(nodeId) ?? []) {
                try {
                    ws.close(4003, 'membership revoked');
                } catch {
                    /* 忽略 */
                }
            }
            sockets.delete(nodeId);
            return membership;
        },
        memberships: () => listMemberships(opts.store),
        connectionCount(nodeId) {
            if (nodeId) return sockets.get(nodeId)?.size ?? 0;
            let n = 0;
            for (const set of sockets.values()) n += set.size;
            return n;
        },
        async close() {
            for (const set of sockets.values()) for (const ws of set) ws.terminate();
            sockets.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
    return handle;
}

function waitForApproval(
    requestId: string,
    waitMs: number,
    waiters: Map<string, (r: PairSuccess) => void>,
): Promise<PairSuccess> {
    return new Promise((resolve) => {
        const timer = setTimeout(
            () => {
                waiters.delete(requestId);
                resolve({ status: 'pending', requestId });
            },
            Math.min(waitMs, 5 * 60 * 1000),
        );
        waiters.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
    });
}

function bearerToken(header: string | undefined): string | null {
    if (!header) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m ? m[1]!.trim() : null;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
    });
    res.end(text);
}

function sendError(res: ServerResponse, e: unknown): void {
    if (isHubError(e)) {
        const status = errorStatus(e.code);
        json(res, status, { error: e.code, message: e.message });
        return;
    }
    json(res, 500, { error: 'hub/internal', message: e instanceof Error ? e.message : String(e) });
}

function errorStatus(code: HubError['code']): number {
    switch (code) {
        case 'invite/not-found':
        case 'pair/not-found':
            return 404;
        case 'invite/expired':
        case 'invite/exhausted':
        case 'invite/already-consumed':
            return 410;
        case 'invite/bad-secret':
        case 'auth/unauthorized':
            return 401;
        case 'auth/forbidden':
            return 403;
        case 'hub/protocol-mismatch':
        case 'hub/bad-input':
            return 400;
        default:
            return 500;
    }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) throw new HubError('hub/bad-input', '请求体过大');
        chunks.push(buf);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
    } catch {
        throw new HubError('hub/bad-input', '请求体不是合法 JSON');
    }
}

// handlers.ts — 把 api.ts 的声明式方法挂到**某一个 binding** 上（每连接一份）。
//
// 为什么是「每连接一份」：授权状态属于连接（这条 WebSocket 有没有登录），而 `binding._on()`
// 的 handler 拿不到连接上下文 —— 于是 handler 闭包持有本连接的 ConnectionState。
// 注册本身是廉价的（就是往 binding 的四张表里填条目），一线程一连接完全可接受。
//
// 三类鉴权（与 api.ts 的分类一致）：
//   · 副方管理面（pending / approve / deny / revoke / tokens）→ 仅**回环**。跨机的主方
//     拿不到 approve，所以「主方自签」在拓扑上就不可达 —— 这是铁律①的落地方式。
//   · Passkey（web.webauthn.*）→ 对任何来源开放；能不能注册由「有没有主用户」决定（判据 3）。
//     RP ID / origin **从这条连接的 Host 头现推**（不硬编码，也不信客户端自报）。
//   · 业务面（web.page.*）→ 两条路并存：本连接的 token，或本连接带来的 Passkey 会话 cookie。
//     无效 / 已 revoke / 过期一律 UNAUTHENTICATED（HTTP 绑定下就是 401）。
//     **只报错、不重试、不续签** —— 铁律②。

import { RpcError, type ServerBinding } from '@diy-agent/rpc';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { webApi } from './api.js';
import type { AuthCore } from './auth.js';
import type { PagesHost } from './pages.js';
import {
    contextFromRequest,
    defaultUsername,
    parseCookies,
    SESSION_COOKIE,
    type WebAuthnContext,
    type WebAuthnCore,
    type WebAuthnUser,
} from './webauthn.js';

/** 连接的对端：地址 + 是否回环（回环 = 副方自己的机器）+ 建连时的 HTTP 头 */
export interface WebPeer {
    readonly address: string;
    readonly loopback: boolean;
    /** 建连请求的 Host（Passkey 用它推 RP ID / origin；不传就采不到，相关方法会报错） */
    readonly host?: string | undefined;
    /** 建连请求的 Cookie 头（Passkey 会话从这里读） */
    readonly cookie?: string | undefined;
    /** 建连请求的 x-forwarded-proto（反代 / tailscale serve 才有） */
    readonly forwardedProto?: string | undefined;
}

/** 一条连接的授权状态（login 写入，logout / 撤销后失效） */
export interface ConnectionState {
    token: string | null;
    /** Passkey 会话 id：建连时来自 cookie，RPC 面 logout 清掉 */
    sessionId: string | null;
}

/** 计数（测试拿它当「没有自动重试」的结构证据：被拒一次 ⇒ 服务端只被调用一次） */
export interface WebRpcStats {
    pageInvokes: number;
    pageRejects: number;
}

export interface WebRpcDeps {
    readonly auth: AuthCore;
    readonly webauthn: WebAuthnCore;
    readonly pages: PagesHost;
    /** 本实例的身份地址（`alice@c-mac/diy-web.lab`，##484） */
    readonly address: string;
    readonly stats: WebRpcStats;
}

export function newWebRpcStats(): WebRpcStats {
    return { pageInvokes: 0, pageRejects: 0 };
}

/** 浏览器侧 `startRegistration()` 的响应：只做「是个对象」这一层兜底，形状由 @simplewebauthn 校验 */
function asWebAuthnResponse<T>(value: unknown, label: string): T {
    if (value === null || typeof value !== 'object') {
        throw new RpcError('INVALID_ARGUMENT', `${label} 必须是 WebAuthn 响应对象`);
    }
    return value as T;
}

export function registerWebApi(binding: ServerBinding, peer: WebPeer, deps: WebRpcDeps): ConnectionState {
    const cookies = parseCookies(peer.cookie);
    const cookieSession = cookies[SESSION_COOKIE] ?? null;
    const connection: ConnectionState = { token: null, sessionId: cookieSession };
    const { auth, webauthn, pages, stats } = deps;

    /** 副方管理面：只对回环开放（跨机主方连 approve 都调不到 ⇒ 无法自签） */
    const requireOperator = (): void => {
        if (!peer.loopback) {
            throw new RpcError(
                'PERMISSION_DENIED',
                `副方管理面只对回环开放（当前来源 ${peer.address}）：跨机请求必须由副方本机确认`,
            );
        }
    };

    /** Passkey 的域：从建连请求的 Host 推（不硬编码、不信客户端自报） */
    const requireContext = (): WebAuthnContext => {
        try {
            return contextFromRequest({ host: peer.host, forwardedProto: peer.forwardedProto });
        } catch (cause) {
            throw new RpcError('FAILED_PRECONDITION', `Passkey 不可用：${String(cause)}`);
        }
    };

    const sessionUser = (): WebAuthnUser | null => webauthn.userOfSession(connection.sessionId);

    /** 业务面：持有有效 token 或有效 Passkey 会话。失败即 UNAUTHENTICATED（HTTP 绑定下 = 401） */
    const requireClient = (): string => {
        const token = connection.token;
        if (token !== null) {
            const record = auth.verify(token);
            if (record !== null) return record.subject;
        }
        const user = sessionUser();
        if (user !== null) return `passkey:${user.id}`;
        stats.pageRejects += 1;
        throw new RpcError('UNAUTHENTICATED', '未连接：需要副方（本机）授权或用 Passkey 登录——不会自动重连', {
            details: { reason: token === null ? 'no-token' : 'token-invalid' },
        });
    };

    // ── 授权：建立关系（对任何来源开放）────────────────────────────

    binding._on("web.auth.request", webApi.web.auth.request, async ({ input }) => {
        const created = auth.request({ subject: input.subject });
        await auth.flush();
        console.info(`[web] 收到连接请求：${input.subject}（${created.requestId}）来自 ${peer.address}`);
        return { requestId: created.requestId, status: created.status, address: deps.address };
    });

    binding._on("web.auth.status", webApi.web.auth.status, ({ input }) => {
        const view = auth.status(input.requestId);
        return { status: view.status, token: view.token, expiresAt: view.expiresAt };
    });

    binding._on("web.auth.login", webApi.web.auth.login, ({ input }) => {
        const record = auth.verify(input.token);
        if (record === null) {
            throw new RpcError('UNAUTHENTICATED', '这个 token 无效 / 已撤销 / 已过期：请让副方重新授权');
        }
        connection.token = record.token;
        console.info(`[web] 主方已登录：${record.subject}（来自 ${peer.address}）`);
        return { subject: record.subject, expiresAt: record.expiresAt };
    });

    binding._on("web.auth.logout", webApi.web.auth.logout, () => {
        connection.token = null;
        return { ok: true };
    });

    binding._on("web.auth.state", webApi.web.auth.state, () => {
        const record = connection.token === null ? null : auth.verify(connection.token);
        if (record === null) {
            // logout / revoke / 过期之后主动清掉，避免「以为还连着」
            connection.token = null;
            return { connected: false, subject: null, expiresAt: null };
        }
        return { connected: true, subject: record.subject, expiresAt: record.expiresAt };
    });

    // ── Passkey（##496）：对任何来源开放，能否注册由「有没有主用户」定 ──

    binding._on("web.webauthn.register.options", webApi.web.webauthn.register.options, async ({ input }) => {
        const created = await webauthn.registrationOptions({
            context: requireContext(),
            ...(input.username === undefined ? {} : { username: input.username }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        });
        return { options: created.options as unknown as Record<string, unknown> };
    });

    binding._on("web.webauthn.register.verify", webApi.web.webauthn.register.verify, async ({ input }) => {
        const response = asWebAuthnResponse<RegistrationResponseJSON>(input.response, 'response');
        const created = await webauthn.verifyRegistration({
            context: requireContext(),
            response,
            ...(input.credentialName === undefined ? {} : { credentialName: input.credentialName }),
        });
        // 判据 7：交出去之前必须已落盘（公钥存进 users.json，私钥始终在钥匙串）
        await webauthn.flush();
        console.info(`[web] 已创建主用户 ${created.user.id}（凭据 ${created.credential.id}）`);
        return created;
    });

    binding._on("web.webauthn.login.options", webApi.web.webauthn.login.options, async () => {
        const created = await webauthn.authenticationOptions({ context: requireContext() });
        return { options: created.options as unknown as Record<string, unknown> };
    });

    binding._on("web.webauthn.login.verify", webApi.web.webauthn.login.verify, async ({ input }) => {
        const response = asWebAuthnResponse<AuthenticationResponseJSON>(input.response, 'response');
        const result = await webauthn.verifyAuthentication({ context: requireContext(), response });
        await webauthn.flush();
        connection.sessionId = result.sessionId;
        console.info(`[web] Passkey 登录成功：${result.user.id}（来自 ${peer.address}）`);
        return result;
    });

    binding._on("web.webauthn.me", webApi.web.webauthn.me, () => {
        const user = sessionUser();
        return {
            hasUser: webauthn.hasUser(),
            user,
            // 还没有主用户时才给建议值（= 系统用户名）；已有用户时它没有意义
            suggestedUsername: webauthn.hasUser() ? null : defaultUsername(),
        };
    });

    binding._on("web.webauthn.logout", webApi.web.webauthn.logout, () => {
        webauthn.logout(connection.sessionId);
        connection.sessionId = null;
        return { ok: true };
    });

    // ── 授权：副方管理面（仅回环）──────────────────────────────────

    binding._on("web.auth.pending", webApi.web.auth.pending, () => {
        requireOperator();
        return {
            requests: auth.pending().map(({ id, subject, note, requestedAt }) => ({
                id,
                subject,
                note,
                requestedAt,
            })),
        };
    });

    binding._on("web.auth.tokens", webApi.web.auth.tokens, () => {
        requireOperator();
        return { tokens: auth.tokens() };
    });

    binding._on("web.auth.approve", webApi.web.auth.approve, async ({ input }) => {
        requireOperator();
        // 有效期用内核缺省（8h）；「允许一次」这类变体留给下一刀（本轮没有 use-count）
        const approved = auth.approve(input.requestId);
        // 签发完先落盘再回给主方：交出去的东西必须跨重启有效（判据 7）
        await auth.flush();
        console.info(`[web] 副方已确认 ${input.requestId}，token 有效期至 ${approved.expiresAt}`);
        return approved;
    });

    binding._on("web.auth.deny", webApi.web.auth.deny, async ({ input }) => {
        requireOperator();
        const denied = auth.deny(input.requestId);
        await auth.flush();
        console.info(`[web] 副方已拒绝 ${input.requestId}`);
        return denied;
    });

    /** 撤销之后的收尾：撤销对本连接立即生效（拿着被撤 token 的下一次调用就 401） */
    const dropIfRevoked = (): void => {
        if (connection.token !== null && auth.verify(connection.token) === null) connection.token = null;
    };

    binding._on("web.auth.revoke", webApi.web.auth.revoke, async ({ input }) => {
        requireOperator();
        const result = auth.revoke({ token: input.token });
        dropIfRevoked();
        await auth.flush();
        console.info(`[web] 副方撤销了 ${result.revoked} 个 token`);
        return result;
    });

    binding._on("web.auth.revokeAll", webApi.web.auth.revokeAll, async () => {
        requireOperator();
        const result = auth.revoke({ all: true });
        dropIfRevoked();
        await auth.flush();
        console.info(`[web] 副方撤销了全部 ${result.revoked} 个 token`);
        return result;
    });

    // ── 业务面：页面调用（需要 token 或 Passkey 会话）──────────────

    binding._on("web.page.list", webApi.web.page.list, () => {
        requireClient();
        return pages.list();
    });

    binding._on("web.page.invoke", webApi.web.page.invoke, async ({ input, signal }) => {
        requireClient();
        stats.pageInvokes += 1;
        return pages.invoke(input.pageId, input.method, input.args, signal);
    });

    return connection;
}

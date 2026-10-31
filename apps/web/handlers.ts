// handlers.ts — 把 api.ts 的声明式方法挂到**某一个 binding** 上（每连接一份）。
//
// 为什么是「每连接一份」：授权状态属于连接（这条 WebSocket 有没有登录），而 `binding.on()`
// 的 handler 拿不到连接上下文 —— 于是 handler 闭包持有本连接的 ConnectionState。
// 注册本身是廉价的（就是往 binding 的四张表里填条目），一线程一连接完全可接受。
//
// 两类鉴权（与 api.ts 的分类一致）：
//   · 副方管理面（pending / approve / deny / revoke / tokens）→ 仅**回环**。跨机的主方
//     拿不到 approve，所以「主方自签」在拓扑上就不可达 —— 这是铁律①的落地方式。
//   · 业务面（web.page.*）→ 本连接必须带有效 token；无效 / 已 revoke / 过期一律
//     UNAUTHENTICATED（HTTP 绑定下就是 401）。**只报错、不重试、不续签** —— 铁律②。

import { RpcError, type ServerBinding } from '@diy-agent/rpc';
import { webApi } from './api.js';
import type { AuthCore } from './auth.js';
import type { PagesHost } from './pages.js';

/** 连接的对端：地址 + 是否回环（回环 = 副方自己的机器） */
export interface WebPeer {
    readonly address: string;
    readonly loopback: boolean;
}

/** 一条连接的授权状态（login 写入，logout / 撤销后失效） */
export interface ConnectionState {
    token: string | null;
}

/** 计数（测试拿它当「没有自动重试」的结构证据：被拒一次 ⇒ 服务端只被调用一次） */
export interface WebRpcStats {
    pageInvokes: number;
    pageRejects: number;
}

export interface WebRpcDeps {
    readonly auth: AuthCore;
    readonly pages: PagesHost;
    /** 本实例的身份地址（`alice@c-mac/diy-web.lab`，##484） */
    readonly address: string;
    readonly stats: WebRpcStats;
}

export function newWebRpcStats(): WebRpcStats {
    return { pageInvokes: 0, pageRejects: 0 };
}

export function registerWebApi(binding: ServerBinding, peer: WebPeer, deps: WebRpcDeps): ConnectionState {
    const connection: ConnectionState = { token: null };
    const { auth, pages, stats } = deps;

    /** 副方管理面：只对回环开放（跨机主方连 approve 都调不到 ⇒ 无法自签） */
    const requireOperator = (): void => {
        if (!peer.loopback) {
            throw new RpcError(
                'PERMISSION_DENIED',
                `副方管理面只对回环开放（当前来源 ${peer.address}）：跨机请求必须由副方本机确认`,
            );
        }
    };

    /** 业务面：本连接必须持有有效 token。失败即 UNAUTHENTICATED（HTTP 绑定下 = 401） */
    const requireClient = (): string => {
        const token = connection.token;
        const record = token === null ? null : auth.verify(token);
        if (record === null) {
            stats.pageRejects += 1;
            throw new RpcError('UNAUTHENTICATED', '未连接：需要副方（本机）重新授权——revoke 之后不会自动重连', {
                details: { reason: token === null ? 'no-token' : 'token-invalid' },
            });
        }
        return record.subject;
    };

    // ── 授权：建立关系（对任何来源开放）────────────────────────────

    binding.on(webApi.web.auth.request, async ({ input }) => {
        const created = auth.request({ subject: input.subject });
        await auth.flush();
        console.info(`[web] 收到连接请求：${input.subject}（${created.requestId}）来自 ${peer.address}`);
        return { requestId: created.requestId, status: created.status, address: deps.address };
    });

    binding.on(webApi.web.auth.status, ({ input }) => {
        const view = auth.status(input.requestId);
        return { status: view.status, token: view.token, expiresAt: view.expiresAt };
    });

    binding.on(webApi.web.auth.login, ({ input }) => {
        const record = auth.verify(input.token);
        if (record === null) {
            throw new RpcError('UNAUTHENTICATED', '这个 token 无效 / 已撤销 / 已过期：请让副方重新授权');
        }
        connection.token = record.token;
        console.info(`[web] 主方已登录：${record.subject}（来自 ${peer.address}）`);
        return { subject: record.subject, expiresAt: record.expiresAt };
    });

    binding.on(webApi.web.auth.logout, () => {
        connection.token = null;
        return { ok: true };
    });

    binding.on(webApi.web.auth.state, () => {
        const record = connection.token === null ? null : auth.verify(connection.token);
        if (record === null) {
            // logout / revoke / 过期之后主动清掉，避免「以为还连着」
            connection.token = null;
            return { connected: false, subject: null, expiresAt: null };
        }
        return { connected: true, subject: record.subject, expiresAt: record.expiresAt };
    });

    // ── 授权：副方管理面（仅回环）──────────────────────────────────

    binding.on(webApi.web.auth.pending, () => {
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

    binding.on(webApi.web.auth.tokens, () => {
        requireOperator();
        return { tokens: auth.tokens() };
    });

    binding.on(webApi.web.auth.approve, async ({ input }) => {
        requireOperator();
        // 有效期用内核缺省（8h）；「允许一次」这类变体留给下一刀（本轮没有 use-count）
        const approved = auth.approve(input.requestId);
        // 签发完先落盘再回给主方：交出去的东西必须跨重启有效（判据 7）
        await auth.flush();
        console.info(`[web] 副方已确认 ${input.requestId}，token 有效期至 ${approved.expiresAt}`);
        return approved;
    });

    binding.on(webApi.web.auth.deny, async ({ input }) => {
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

    binding.on(webApi.web.auth.revoke, async ({ input }) => {
        requireOperator();
        const result = auth.revoke({ token: input.token });
        dropIfRevoked();
        await auth.flush();
        console.info(`[web] 副方撤销了 ${result.revoked} 个 token`);
        return result;
    });

    binding.on(webApi.web.auth.revokeAll, async () => {
        requireOperator();
        const result = auth.revoke({ all: true });
        dropIfRevoked();
        await auth.flush();
        console.info(`[web] 副方撤销了全部 ${result.revoked} 个 token`);
        return result;
    });

    // ── 业务面：页面调用（需要 token）──────────────────────────────

    binding.on(webApi.web.page.list, () => {
        requireClient();
        return pages.list();
    });

    binding.on(webApi.web.page.invoke, async ({ input, signal }) => {
        requireClient();
        stats.pageInvokes += 1;
        return pages.invoke(input.pageId, input.method, input.args, signal);
    });

    return connection;
}

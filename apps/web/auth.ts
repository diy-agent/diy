// auth.ts — 单向授权的内核：请求 / 确认 / token / revoke。
//
// 两条铁律（##485 用户裁决，改这两条等于改设计）：
//   ① **token 只能由副方生成**。副方 = 被控方 = 本服务的宿主；主方（要控制它的人）自签的 token
//      一律不认 —— 所以签发只发生在 `approve()`，而 `approve()` 只在副方的管理面（回环）可达
//      （限制在 handlers.ts 的 `requireOperator`，这里只负责「谁签发」）。
//   ② **revoke 之后主方不许自动重试**。`verify()` 对已撤销 / 过期的 token 返回 null，
//      客户端见到 UNAUTHENTICATED 就回「未连接」，等副方重新授权（重试循环会等于绕过 ②）。
//
// 两层，IO 与判定分开：
//   · createAuth(state, deps) —— 纯状态机。时间 / 随机数 / id 全由 deps 注入，判据钉死在单测里；
//   · openAuthStore(file)    —— 落盘（`$DIY_HOME/web/auth.json`，0600）。授权关系必须跨重启活着
//                               （判据 7：token 存 store，不是 localStorage）。
//
// 「记住」≠「绕过确认」：approve 只是发一个长期 token；revoke 之后即便还记着，也必须重新确认。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RpcError } from '@diy-agent/rpc';

/** 一条连接请求的生命周期（副方看的那一栏） */
export type RequestStatus = 'pending' | 'approved' | 'denied';

export interface AuthRequest {
    readonly id: string;
    /** 主方自报的身份地址，形如 `alice@c-mac/diy-chat.lab`（##484 的 displayAddress 格式） */
    readonly subject: string;
    readonly note: string | null;
    readonly requestedAt: string;
    readonly status: RequestStatus;
    readonly decidedAt: string | null;
    /** approve 发出的那个 token 的 id（denied / pending 为 null） */
    readonly tokenId: string | null;
}

export interface AuthToken {
    readonly id: string;
    /** 真正的凭据（副方生成，主方只持有） */
    readonly token: string;
    readonly subject: string;
    readonly issuedAt: string;
    /** ISO 时刻；到点即失效（verify 返回 null） */
    readonly expiresAt: string;
    readonly revokedAt: string | null;
}

export interface AuthState {
    readonly requests: readonly AuthRequest[];
    readonly tokens: readonly AuthToken[];
}

/** 注入点：时间 / id / token 生成（测试用确定性实现，生产用 crypto） */
export interface AuthDeps {
    readonly now: () => Date;
    readonly newId: () => string;
    readonly newToken: () => string;
}

/** 缺省有效期：8h（body ③） */
export const DEFAULT_TTL_HOURS = 8;

/** 请求流水上限：只留最近这么多条（无用的历史不必长在磁盘上） */
export const MAX_REQUESTS = 100;

export function emptyAuthState(): AuthState {
    return { requests: [], tokens: [] };
}

/** 给主方看的请求视图（token 只在 approved 之后出现） */
export interface RequestView {
    readonly requestId: string;
    readonly status: RequestStatus;
    readonly token: string | null;
    readonly expiresAt: string | null;
}

/** 副方管理面看到的授权条目（不带 token 明文：副方自己不需要再读它） */
export interface TokenView {
    readonly id: string;
    readonly subject: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly revokedAt: string | null;
}

export interface AuthCore {
    state(): AuthState;
    /** 主方：发起连接请求（同一 subject 已有 pending 时复用那一条，避免连点生成一串） */
    request(input: { readonly subject: string; readonly note?: string | null }): {
        requestId: string;
        status: RequestStatus;
    };
    /** 主方：轮询结果；approved 时把副方生成的 token 交回去 */
    status(requestId: string): RequestView;
    /** 副方：允许（token 在此生成 —— 唯一的签发点） */
    approve(requestId: string, ttlHours?: number): { requestId: string; token: string; expiresAt: string };
    /** 副方：拒绝 */
    deny(requestId: string): { requestId: string };
    /** 任一调用方：token → 有效记录（过期 / 已撤销 / 不存在都返回 null） */
    verify(token: string): AuthToken | null;
    /** 副方：断开本次连接（撤销 token）；`all` = 全部撤销 */
    revoke(input: { readonly token?: string; readonly all?: boolean }): { revoked: number };
    /** 副方：待确认请求 */
    pending(): AuthRequest[];
    /** 副方：已授权列表（不含 token 明文） */
    tokens(): TokenView[];
    /**
     * 等落盘写完（内存态实现 = 立即完成）。
     * 为什么要 await：token 是「副方签发、跨重启有效」的凭据 —— 交出去之前必须已落盘，
     * 否则进程刚发完就崩，主方手里那枚 token 就是废纸（测试里表现为「重启后无效」）。
     */
    flush(): Promise<void>;
}

/**
 * 纯状态机。`onChange` 在每次变更后被调用（store 用它落盘），抛错不影响内存态。
 *
 * 不变量：`requests` 只增不改除 status / decidedAt / tokenId；`tokens` 只增 + revokedAt 单向置位
 * （审计要的是流水，不是当前值）。
 */
export function createAuth(initial: AuthState, deps: AuthDeps, onChange?: (state: AuthState) => void): AuthCore {
    let current = normalize(initial);

    const commit = (next: AuthState): void => {
        current = normalize(next);
        onChange?.(current);
    };

    const iso = (): string => deps.now().toISOString();

    const findRequest = (requestId: string): AuthRequest => {
        const hit = current.requests.find((item) => item.id === requestId);
        if (hit === undefined) {
            throw new RpcError('NOT_FOUND', `没有这条连接请求：${requestId}`);
        }
        return hit;
    };

    const replaceRequest = (target: AuthRequest): AuthRequest[] =>
        current.requests.map((item) => (item.id === target.id ? target : item));

    return {
        state: () => current,

        request(input) {
            const subject = input.subject.trim();
            if (subject === '') {
                throw new RpcError('INVALID_ARGUMENT', '主方必须自报身份（subject 不能为空）');
            }
            const existing = current.requests.find((item) => item.status === 'pending' && item.subject === subject);
            if (existing !== undefined) {
                return { requestId: existing.id, status: existing.status };
            }
            const created: AuthRequest = {
                id: deps.newId(),
                subject,
                note: input.note ?? null,
                requestedAt: iso(),
                status: 'pending',
                decidedAt: null,
                tokenId: null,
            };
            commit({ requests: [...current.requests, created], tokens: current.tokens });
            return { requestId: created.id, status: created.status };
        },

        status(requestId) {
            const found = findRequest(requestId);
            const token =
                found.tokenId === null
                    ? null
                    : (current.tokens.find((item) => item.id === found.tokenId)?.token ?? null);
            return {
                requestId: found.id,
                status: found.status,
                token,
                expiresAt:
                    found.tokenId === null
                        ? null
                        : (current.tokens.find((item) => item.id === found.tokenId)?.expiresAt ?? null),
            };
        },

        approve(requestId, ttlHours = DEFAULT_TTL_HOURS) {
            const found = findRequest(requestId);
            if (found.status !== 'pending') {
                throw new RpcError(
                    'FAILED_PRECONDITION',
                    `请求 ${requestId} 已经是 ${found.status}，只能确认 pending 的请求`,
                );
            }
            if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
                throw new RpcError('INVALID_ARGUMENT', `有效期不合法：${String(ttlHours)} 小时`);
            }
            // ⚠️ 唯一的签发点：token 由副方（= 本宿主）生成，主方永远拿不到生成权。
            const issuedAt = deps.now();
            const expiresAt = new Date(issuedAt.getTime() + ttlHours * 3600_000);
            const token: AuthToken = {
                id: deps.newId(),
                token: deps.newToken(),
                subject: found.subject,
                issuedAt: issuedAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                revokedAt: null,
            };
            const approved: AuthRequest = {
                ...found,
                status: 'approved',
                decidedAt: issuedAt.toISOString(),
                tokenId: token.id,
            };
            commit({ requests: replaceRequest(approved), tokens: [...current.tokens, token] });
            return { requestId, token: token.token, expiresAt: token.expiresAt };
        },

        deny(requestId) {
            const found = findRequest(requestId);
            if (found.status !== 'pending') {
                throw new RpcError('FAILED_PRECONDITION', `请求 ${requestId} 已经是 ${found.status}`);
            }
            commit({
                requests: replaceRequest({ ...found, status: 'denied', decidedAt: iso() }),
                tokens: current.tokens,
            });
            return { requestId };
        },

        verify(token) {
            const found = current.tokens.find((item) => item.token === token);
            if (found === undefined) return null;
            if (found.revokedAt !== null) return null;
            if (Date.parse(found.expiresAt) <= deps.now().getTime()) return null;
            return found;
        },

        revoke(input) {
            if (input.all !== true && (input.token === undefined || input.token === '')) {
                throw new RpcError('INVALID_ARGUMENT', 'revoke 需要 token（或 all: true）');
            }
            const revokedAt = iso();
            let count = 0;
            const tokens = current.tokens.map((item) => {
                const hit = input.all === true ? item.revokedAt === null : item.token === input.token;
                if (!hit || item.revokedAt !== null) return item;
                count += 1;
                return { ...item, revokedAt };
            });
            commit({ requests: current.requests, tokens });
            return { revoked: count };
        },

        pending: () => current.requests.filter((item) => item.status === 'pending'),

        tokens: () =>
            current.tokens.map(({ id, subject, issuedAt, expiresAt, revokedAt }) => ({
                id,
                subject,
                issuedAt,
                expiresAt,
                revokedAt,
            })),

        // 纯内存态没有落盘，天然「已写完」
        flush: () => Promise.resolve(),
    };
}

/** 读盘时宽松归一：坏条目丢弃，别因为一个坏文件把服务卡住 */
function normalize(state: AuthState): AuthState {
    const requests = state.requests.filter((item) => isRequest(item)).slice(-MAX_REQUESTS);
    const tokens = state.tokens.filter((item) => isToken(item));
    return { requests, tokens };
}

function isRequest(value: unknown): value is AuthRequest {
    if (value === null || typeof value !== 'object') return false;
    const item = value as Partial<Record<keyof AuthRequest, unknown>>;
    return (
        typeof item.id === 'string' &&
        typeof item.subject === 'string' &&
        typeof item.requestedAt === 'string' &&
        (item.status === 'pending' || item.status === 'approved' || item.status === 'denied')
    );
}

function isToken(value: unknown): value is AuthToken {
    if (value === null || typeof value !== 'object') return false;
    const item = value as Partial<Record<keyof AuthToken, unknown>>;
    return (
        typeof item.id === 'string' &&
        typeof item.token === 'string' &&
        typeof item.subject === 'string' &&
        typeof item.expiresAt === 'string'
    );
}

/** store 文件的位置（相对数据根）：`<home>/web/auth.json` */
export function authStorePath(home: string): string {
    return `${home}/web/auth.json`;
}

/**
 * 打开落盘 store：读一次 → 变更即写（0600，先写临时文件再 rename，半截文件不会顶替好文件）。
 *
 * 读侧宽松（文件缺失 / 坏 JSON ⇒ 空态 + 一行警告）；写侧失败只警告 —— 服务不该因为
 * 授权流水写不进去就停摆（但必须留痕：症状是「重启后要重新授权」）。
 */
export async function openAuthStore(file: string, deps: AuthDeps): Promise<AuthCore> {
    let initial = emptyAuthState();
    try {
        const raw = await readFile(file, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
            const shape = parsed as { requests?: unknown; tokens?: unknown };
            initial = {
                requests: Array.isArray(shape.requests) ? (shape.requests as AuthRequest[]) : [],
                tokens: Array.isArray(shape.tokens) ? (shape.tokens as AuthToken[]) : [],
            };
        }
    } catch (cause) {
        const code = (cause as { code?: string }).code;
        if (code !== 'ENOENT') console.warn(`[web] 授权 store 读取失败（按空态起）：${file}`, cause);
    }

    let chain: Promise<void> = Promise.resolve();
    const persist = (state: AuthState): void => {
        // 串行化：同一时刻只有一个写在飞（并发写临时文件会互相覆盖）
        chain = chain
            .then(async () => {
                await mkdir(dirname(file), { recursive: true });
                const tmp = `${file}.${process.pid}.tmp`;
                await writeFile(tmp, `${JSON.stringify(state, null, 4)}\n`, { encoding: 'utf-8', mode: 0o600 });
                await rename(tmp, file);
            })
            .catch((cause: unknown) => {
                console.warn(`[web] 授权 store 写入失败：${file}`, cause);
            });
    };

    const core = createAuth(initial, deps, persist);
    return { ...core, flush: () => chain };
}

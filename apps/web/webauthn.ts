// webauthn.ts — Passkey（WebAuthn）内核：注册 / 登录 / 会话（##496）。
//
// 三块，IO 与判定分开（与 auth.ts 同一口味）：
//   · 内核：challenge / 用户 / 凭证 / 会话的判定，时间与随机数全部由 deps 注入；
//   · 落盘：`$DIY_HOME/web/users.json`（0600，先写临时文件再 rename）—— **只存公钥**，
//           私钥永远在系统钥匙串（判据 7）；
//   · 边缘：contextFromRequest（RP ID / origin 从请求推，见下）+ cookie 的拼/解。
//
// 三条硬约束（body「关键实现点」）：
//   ① RP ID 从 `location.hostname` 推，**不硬编码** —— 服务端等价物是从 Host 头推 rpID / origin；
//   ② challenge **不落盘**：内存 Map + 5 分钟 TTL + 一次性消费（进程重启丢失可接受）；
//   ③ `userVerification: 'required'` + `residentKey: 'required'`：强制 Touch ID、发现式凭证
//      （登录时 allowCredentials 留空，不用先输用户名）。
//
// 验签一律交给 @simplewebauthn/server，本文件不碰 COSE / ECDSA 细节（用户裁决）。
//
// 会话：7 天，HttpOnly cookie（值 = 会话 id）。**cookie 只在 HTTP 面能下发**（Set-Cookie 是
// HTTP 响应头，WebSocket 升级响应带不了）—— 见 server.ts 的 `/webauthn/*`；RPC 面
// （web.webauthn.*）只会把 sessionId 明确交回调用方，供 Node 客户端自己保存。

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { RpcError } from '@diy-agent/rpc';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';

/** RP 显示名（浏览器弹窗里那一行） */
export const RP_NAME = 'diy';

/**
 * 主用户的缺省用户名：**系统用户名**（`os.userInfo().username`），拿不到就 `diy`。
 *
 * 为什么不能写死 'owner'：这个串会原样出现在系统钥匙串 / iPhone 通行密钥列表里，
 * 用户看到的是「owner」而不是自己（##496 用户澄清 3）。
 */
export function defaultUsername(): string {
    try {
        const name = userInfo().username.trim();
        if (name !== '') return name;
    } catch {
        // 无 passwd 条目的容器里 userInfo() 会抛：回落到 `diy`
    }
    return 'diy';
}

/** challenge 存活时间：5 分钟（body） */
export const CHALLENGE_TTL_MS = 5 * 60_000;

/** 会话存活时间：7 天（body） */
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** 会话 cookie 名 */
export const SESSION_COOKIE = 'diy_passkey';

export interface WebAuthnUser {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly role: 'owner';
    readonly status: 'active';
    readonly createdAt: number;
}

export interface WebAuthnCredential {
    /** base64url credential ID */
    readonly id: string;
    readonly userId: string;
    /** base64url（COSE 公钥）—— **没有私钥** */
    readonly publicKey: string;
    readonly counter: number;
    readonly transports?: string[];
    readonly deviceType: 'singleDevice' | 'multiDevice';
    readonly backedUp: boolean;
    readonly name: string;
    readonly createdAt: number;
    readonly lastUsedAt: number;
}

export interface WebAuthnStore {
    readonly version: 1;
    readonly users: readonly WebAuthnUser[];
    readonly credentials: readonly WebAuthnCredential[];
}

/** 一次 WebAuthn 的「域」：RP ID + origin，**每次请求现推**（不落盘、不全局缓存） */
export interface WebAuthnContext {
    readonly rpID: string;
    readonly origin: string;
}

export interface WebAuthnDeps {
    readonly now: () => number;
    readonly newId: () => string;
}

/** 给浏览器 / 调用方看的用户视图（与落盘结构同形，但不含任何凭证） */
export type WebAuthnUserView = WebAuthnUser;

export interface WebAuthnCredentialView {
    readonly id: string;
    readonly name: string;
    readonly deviceType: 'singleDevice' | 'multiDevice';
    readonly backedUp: boolean;
    readonly createdAt: number;
    readonly lastUsedAt: number;
}

export interface WebAuthnCore {
    store(): WebAuthnStore;
    /** 有没有主用户（判据 3 的判据：非空即拒绝再次注册） */
    hasUser(): boolean;
    /** ① 注册参数（仅当还没有主用户时允许） */
    registrationOptions(input: {
        readonly context: WebAuthnContext;
        /** 通行密钥里的用户名（缺省 = 系统用户名，见 defaultUsername） */
        readonly username?: string;
        /** 通行密钥里的显示名（缺省 = username） */
        readonly displayName?: string;
    }): Promise<{ readonly options: PublicKeyCredentialCreationOptionsJSON }>;
    /** ② 验注册响应 → 建用户 + 存凭证（**不发会话**：判据 2/4 要求创建后刷新仍是登录页） */
    verifyRegistration(input: {
        readonly context: WebAuthnContext;
        readonly response: RegistrationResponseJSON;
        readonly credentialName?: string;
    }): Promise<{ readonly user: WebAuthnUserView; readonly credential: WebAuthnCredentialView }>;
    /** ③ 登录参数（发现式：allowCredentials 留空） */
    authenticationOptions(input: { readonly context: WebAuthnContext }): Promise<{
        readonly options: PublicKeyCredentialRequestOptionsJSON;
    }>;
    /** ④ 验登录响应 → 更新 counter → 发会话 */
    verifyAuthentication(input: {
        readonly context: WebAuthnContext;
        readonly response: AuthenticationResponseJSON;
    }): Promise<{ readonly user: WebAuthnUserView; readonly sessionId: string; readonly expiresAt: number }>;
    /** 会话 id → 用户（过期 / 不存在 / 用户没了都返回 null） */
    userOfSession(sessionId: string | null): WebAuthnUser | null;
    /** 清掉一个会话（登出），返回是否真删掉了 */
    logout(sessionId: string | null): boolean;
    /** 等落盘写完（与 auth.ts 同一语义：交出去之前必须已落盘） */
    flush(): Promise<void>;
}

export function emptyWebAuthnStore(): WebAuthnStore {
    return { version: 1, users: [], credentials: [] };
}

/** 注册时挂在 challenge 上的「待落地用户」 */
interface PendingUser {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly createdAt: number;
}

interface ChallengeEntry {
    readonly kind: 'registration' | 'authentication';
    readonly expiresAt: number;
    readonly user?: PendingUser;
}

/**
 * 从请求的头推 WebAuthn 域。
 *
 * - rpID = Host 的主机名（去端口；IPv6 去方括号）—— 用户裁决：从 hostname 推，不硬编码；
 * - origin = `scheme://<Host>`，scheme 取 `x-forwarded-proto`，否则回环默认 http、其余 https
 *   （tailscale serve 在 443 上终结 TLS，浏览器看到的 origin 就是 https）。
 *
 * `DIY_WEBAUTHN_ORIGIN` / `DIY_WEBAUTHN_RP_ID` 只作为**测试与反代纠偏**的显式覆盖口；
 * 正常路径一律现推 —— 覆盖值不进代码、不进配置默认值。
 */
export function contextFromRequest(input: {
    readonly host?: string | undefined;
    readonly forwardedProto?: string | undefined;
    readonly env?: Record<string, string | undefined>;
}): WebAuthnContext {
    const env = input.env ?? process.env;
    const hostHeader = (input.host ?? '').trim();
    if (hostHeader === '') {
        throw new RpcError('INVALID_ARGUMENT', 'WebAuthn 需要 Host 头来推 RP ID / origin');
    }
    const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    const proto = input.forwardedProto?.split(',')[0]?.trim() || (loopback ? 'http' : 'https');
    const overrideOrigin = env['DIY_WEBAUTHN_ORIGIN'];
    const overrideRpId = env['DIY_WEBAUTHN_RP_ID'];
    return {
        rpID: overrideRpId !== undefined && overrideRpId !== '' ? overrideRpId : hostname,
        origin: overrideOrigin !== undefined && overrideOrigin !== '' ? overrideOrigin : `${proto}://${hostHeader}`,
    };
}

/** 解析 Cookie 头（只认值，不认属性；同名取第一个） */
export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (header === undefined) return out;
    for (const part of header.split(';')) {
        const at = part.indexOf('=');
        if (at <= 0) continue;
        const name = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim();
        if (name !== '' && out[name] === undefined) out[name] = decodeURIComponent(value);
    }
    return out;
}

/** 会话 cookie 的 Set-Cookie 值（HttpOnly + SameSite=Lax + Secure + 7 天） */
export function sessionCookie(
    sessionId: string,
    options: { readonly secure: boolean; readonly maxAgeMs?: number },
): string {
    const maxAge = Math.floor((options.maxAgeMs ?? SESSION_TTL_MS) / 1000);
    return [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        'Path=/',
        `Max-Age=${maxAge}`,
        'HttpOnly',
        'SameSite=Lax',
        ...(options.secure ? ['Secure'] : []),
    ].join('; ');
}

/** 清 cookie（登出）：同名 + Max-Age=0 */
export function clearSessionCookie(options: { readonly secure: boolean }): string {
    return [
        `${SESSION_COOKIE}=`,
        'Path=/',
        'Max-Age=0',
        'HttpOnly',
        'SameSite=Lax',
        ...(options.secure ? ['Secure'] : []),
    ].join('; ');
}

/**
 * 纯内核。challenge 与会话都是**内存态**（body：challenge 不落盘；会话同理，重启后重新登录）。
 */
export function createWebAuthn(
    initial: WebAuthnStore,
    deps: WebAuthnDeps,
    onChange?: (state: WebAuthnStore) => void,
): WebAuthnCore {
    let current = normalize(initial);
    const challenges = new Map<string, ChallengeEntry>();
    const sessions = new Map<string, { userId: string; expiresAt: number }>();

    const commit = (next: WebAuthnStore): void => {
        current = normalize(next);
        onChange?.(current);
    };

    const userById = (id: string): WebAuthnUser | undefined => current.users.find((item) => item.id === id);

    // ── challenge：一次性 + TTL ──────────────────────────────────────

    const remember = (entry: ChallengeEntry, challenge: string): string => {
        // 顺手清过期的：它是「Map 会长到多大」的唯一来源
        for (const [key, value] of challenges) if (value.expiresAt <= deps.now()) challenges.delete(key);
        challenges.set(challenge, entry);
        return challenge;
    };

    /** 看一眼（不消费）：不存在 / 过期 / 类型不符都直接抛，错误信息要能让用户知道「重新点一次」 */
    const peek = (challenge: string, kind: ChallengeEntry['kind']): ChallengeEntry => {
        const entry = challenges.get(challenge);
        if (entry === undefined) {
            throw new RpcError('FAILED_PRECONDITION', 'challenge 不认识或已被用过：请重新发起一次');
        }
        if (entry.expiresAt <= deps.now()) {
            challenges.delete(challenge);
            throw new RpcError('FAILED_PRECONDITION', 'challenge 已过期（5 分钟）：请重新发起一次');
        }
        if (entry.kind !== kind) {
            throw new RpcError('FAILED_PRECONDITION', `challenge 用错了地方（期望 ${kind}）`);
        }
        challenges.delete(challenge);
        return entry;
    };

    // ── 会话 ────────────────────────────────────────────────────────

    const issueSession = (userId: string): { sessionId: string; expiresAt: number } => {
        const now = deps.now();
        for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
        const sessionId = `${deps.newId()}${deps.newId()}`;
        const expiresAt = now + SESSION_TTL_MS;
        sessions.set(sessionId, { userId, expiresAt });
        return { sessionId, expiresAt };
    };

    return {
        store: () => current,

        hasUser: () => current.users.length > 0,

        async registrationOptions(input) {
            if (current.users.length > 0) {
                // 判据 3：首次注册只允许一次
                throw new RpcError('FAILED_PRECONDITION', '已存在主用户：不再接受新的注册（第一版单用户）');
            }
            const now = deps.now();
            const username = (input.username ?? '').trim() || defaultUsername();
            const pending: PendingUser = {
                id: `usr_${deps.newId()}`,
                username,
                displayName: (input.displayName ?? '').trim() || username,
                createdAt: now,
            };
            const options = await generateRegistrationOptions({
                rpName: RP_NAME,
                rpID: input.context.rpID,
                // 用户手柄用 usr_… 的 UTF-8 字节：与落盘的 user.id 一致，不另造一套 id
                userID: isoUint8Array.fromUTF8String(pending.id),
                userName: pending.username,
                userDisplayName: pending.displayName,
                timeout: CHALLENGE_TTL_MS,
                // 不要求厂商证明（本机自用）
                attestationType: 'none',
                excludeCredentials: current.credentials.map((item) => ({
                    id: item.id,
                    ...(item.transports === undefined ? {} : { transports: item.transports }),
                })),
                authenticatorSelection: {
                    // 判据 4：发现式凭证（登录不用先输用户名）
                    residentKey: 'required',
                    // 判据 5：强制 Touch ID
                    userVerification: 'required',
                },
            });
            remember({ kind: 'registration', expiresAt: now + CHALLENGE_TTL_MS, user: pending }, options.challenge);
            return { options };
        },

        async verifyRegistration(input) {
            const client = decodeClientDataJSON(input.response.response.clientDataJSON);
            const entry = peek(client.challenge, 'registration');
            const pending = entry.user;
            if (pending === undefined) {
                throw new RpcError('INTERNAL', '注册 challenge 上没有待落地用户：请重新发起一次');
            }
            const result = await verifyRegistrationResponse({
                response: input.response,
                expectedChallenge: client.challenge,
                expectedOrigin: input.context.origin,
                expectedRPID: input.context.rpID,
                requireUserVerification: true,
            });
            if (!result.verified) {
                throw new RpcError('FAILED_PRECONDITION', '注册验签没通过（浏览器拒绝或响应被篡改）');
            }
            const info = result.registrationInfo;
            const now = deps.now();
            const user: WebAuthnUser = {
                id: pending.id,
                username: pending.username,
                displayName: pending.displayName,
                role: 'owner',
                status: 'active',
                createdAt: pending.createdAt,
            };
            const credential: WebAuthnCredential = {
                id: info.credential.id,
                userId: user.id,
                // 只存公钥：私钥在系统钥匙串（判据 7）
                publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
                counter: info.credential.counter,
                ...(info.credential.transports === undefined ? {} : { transports: info.credential.transports }),
                deviceType: info.credentialDeviceType,
                backedUp: info.credentialBackedUp,
                name: (input.credentialName ?? '').trim() || 'Mac Touch ID',
                createdAt: now,
                lastUsedAt: now,
            };
            commit({ version: 1, users: [...current.users, user], credentials: [...current.credentials, credential] });
            return { user, credential: credentialView(credential) };
        },

        async authenticationOptions(input) {
            if (current.users.length === 0) {
                throw new RpcError('FAILED_PRECONDITION', '还没有主用户：先创建（POST /webauthn/register/options）');
            }
            const options = await generateAuthenticationOptions({
                rpID: input.context.rpID,
                // 发现式：不列 allowCredentials，由 authenticator 自己挑
                allowCredentials: [],
                userVerification: 'required',
                timeout: CHALLENGE_TTL_MS,
            });
            remember({ kind: 'authentication', expiresAt: deps.now() + CHALLENGE_TTL_MS }, options.challenge);
            return { options };
        },

        async verifyAuthentication(input) {
            const client = decodeClientDataJSON(input.response.response.clientDataJSON);
            peek(client.challenge, 'authentication');
            const stored = current.credentials.find((item) => item.id === input.response.id);
            if (stored === undefined) {
                throw new RpcError('NOT_FOUND', '这个凭据没有登记过：请重新注册，或换一台已注册的设备');
            }
            const result = await verifyAuthenticationResponse({
                response: input.response,
                expectedChallenge: client.challenge,
                expectedOrigin: input.context.origin,
                expectedRPID: input.context.rpID,
                credential: {
                    id: stored.id,
                    publicKey: isoBase64URL.toBuffer(stored.publicKey),
                    counter: stored.counter,
                    ...(stored.transports === undefined ? {} : { transports: stored.transports }),
                },
                requireUserVerification: true,
            });
            if (!result.verified) {
                throw new RpcError('UNAUTHENTICATED', '登录验签没通过（Touch ID 未通过或响应被篡改）');
            }
            const now = deps.now();
            // counter 必须更新（body 关键点 7：防克隆检测）
            const nextCounter = result.authenticationInfo.newCounter;
            commit({
                version: 1,
                users: current.users,
                credentials: current.credentials.map((item) =>
                    item.id === stored.id ? { ...item, counter: nextCounter, lastUsedAt: now } : item,
                ),
            });
            const user = userById(stored.userId);
            if (user === undefined) {
                throw new RpcError('NOT_FOUND', `凭据 ${stored.id} 指向的用户不存在了`);
            }
            const session = issueSession(user.id);
            return { user, sessionId: session.sessionId, expiresAt: session.expiresAt };
        },

        userOfSession(sessionId) {
            if (sessionId === null || sessionId === '') return null;
            const found = sessions.get(sessionId);
            if (found === undefined) return null;
            if (found.expiresAt <= deps.now()) {
                sessions.delete(sessionId);
                return null;
            }
            return userById(found.userId) ?? null;
        },

        logout(sessionId) {
            if (sessionId === null || sessionId === '') return false;
            return sessions.delete(sessionId);
        },

        flush: () => Promise.resolve(),
    };
}

function credentialView(item: WebAuthnCredential): WebAuthnCredentialView {
    return {
        id: item.id,
        name: item.name,
        deviceType: item.deviceType,
        backedUp: item.backedUp,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
    };
}

/** 读盘时宽松归一：坏条目丢弃（与 auth.ts 同一口径：一个坏文件不该把服务卡住） */
function normalize(state: WebAuthnStore): WebAuthnStore {
    const users = Array.isArray(state.users) ? state.users.filter((item) => isUser(item)) : [];
    const ids = new Set(users.map((item) => item.id));
    const credentials = Array.isArray(state.credentials)
        ? state.credentials.filter((item) => isCredential(item) && ids.has(item.userId))
        : [];
    return { version: 1, users, credentials };
}

function isUser(value: unknown): value is WebAuthnUser {
    if (value === null || typeof value !== 'object') return false;
    const item = value as Partial<Record<keyof WebAuthnUser, unknown>>;
    return (
        typeof item.id === 'string' &&
        typeof item.username === 'string' &&
        typeof item.displayName === 'string' &&
        item.role === 'owner' &&
        item.status === 'active' &&
        typeof item.createdAt === 'number'
    );
}

function isCredential(value: unknown): value is WebAuthnCredential {
    if (value === null || typeof value !== 'object') return false;
    const item = value as Partial<Record<keyof WebAuthnCredential, unknown>>;
    return (
        typeof item.id === 'string' &&
        typeof item.userId === 'string' &&
        typeof item.publicKey === 'string' &&
        typeof item.counter === 'number' &&
        typeof item.createdAt === 'number'
    );
}

/** store 文件的位置（相对数据根）：`<home>/web/users.json`（与 auth.json 同级） */
export function webauthnStorePath(home: string): string {
    return `${home}/web/users.json`;
}

/**
 * 打开落盘 store：读一次 → 变更即写（0600，先写临时文件再 rename）。
 * 读写两侧的宽松口径与 auth.ts 一致：读不到 = 空态；写失败只警告（症状是「重启后要重新注册」）。
 */
export async function openWebAuthnStore(file: string, deps: WebAuthnDeps): Promise<WebAuthnCore> {
    let initial = emptyWebAuthnStore();
    try {
        const raw = await readFile(file, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
            const shape = parsed as { users?: unknown; credentials?: unknown };
            initial = {
                version: 1,
                users: Array.isArray(shape.users) ? (shape.users as WebAuthnUser[]) : [],
                credentials: Array.isArray(shape.credentials) ? (shape.credentials as WebAuthnCredential[]) : [],
            };
        }
    } catch (cause) {
        const code = (cause as { code?: string }).code;
        if (code !== 'ENOENT') console.warn(`[web] Passkey store 读取失败（按空态起）：${file}`, cause);
    }

    let chain: Promise<void> = Promise.resolve();
    const persist = (state: WebAuthnStore): void => {
        chain = chain
            .then(async () => {
                await mkdir(dirname(file), { recursive: true });
                const tmp = `${file}.${process.pid}.tmp`;
                await writeFile(tmp, `${JSON.stringify(state, null, 4)}\n`, { encoding: 'utf-8', mode: 0o600 });
                await rename(tmp, file);
            })
            .catch((cause: unknown) => {
                console.warn(`[web] Passkey store 写入失败：${file}`, cause);
            });
    };

    const core = createWebAuthn(initial, deps, persist);
    return { ...core, flush: () => chain };
}

/** 生产用的 deps：真时钟 + 真随机（测试传确定性实现） */
export function defaultWebAuthnDeps(): WebAuthnDeps {
    return {
        now: () => Date.now(),
        newId: () => randomUUID(),
    };
}

/** 直接给客户端一个「随机 challenge」（仅测试与工具用；正常路径由 @simplewebauthn 生成） */
export function randomChallenge(): string {
    return isoBase64URL.fromBuffer(randomBytes(32));
}

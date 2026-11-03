// @diy-agent/hub — 契约类型（##500 / docs/plans/2026-11-01-hub-pairing.md）
//
// 三个身份分开，别混：
//   Owner        谁拥有这台机器（Passkey，本包不管）
//   Node         哪个 diy 实例（`$DIY_HOME/instance-id`，由 @diy-agent/remote 管）
//   Hub          哪个 Node 是主控（TLS + 公钥 pinning，本包管）
//
// 三个状态机也分开：Invitation / PairingRequest / Membership —— 同一个 peers.json 里三个数组。

/** 一个信任网络。v1 固定 `"default"`，**字段在所有数据结构里预留**（将来加第二个域不用迁移） */
export type DomainId = string;

/** 一个 diy 安装实例（`diy-xxxxxxxx`） */
export type NodeId = string;

/** 一个 Node 在一个 Domain 的成员关系 */
export type MembershipId = string;

/** v1 唯一支持的域 */
export const DEFAULT_DOMAIN_ID: DomainId = 'default';

/**
 * 配对协议（##513）：两条**同级别**的信任路径，邀请自己带协议。
 *
 *   code        6 位码 + Owner 批准。信任来源 = TLS 证书 + 人工输码 + 人工批准，
 *               **必须有受信任 CA**（tailscale cert），否则 `tls/requires-trusted-cert`。
 *   pinned-key  公钥指纹 pin（TOFU，和 SSH 一个思路）。信任来源 = 人眼比对指纹，
 *               **不需要 CA**，明文 HTTP 也能用（篡改会被指纹比对抓住）。
 */
export type PairingProtocol = 'code' | 'pinned-key';

/** 缺省协议：老邀请（没有 `protocol` 字段）一律按码协议解释 */
export const DEFAULT_PAIRING_PROTOCOL: PairingProtocol = 'code';

export function isPairingProtocol(value: unknown): value is PairingProtocol {
    return value === 'code' || value === 'pinned-key';
}

/** 6 位 Base32（Crockford 字母表，去掉 I / L / O / U） */
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 5 分钟有效 */
export const INVITE_TTL_MS = 5 * 60 * 1000;
/** 每个邀请全局 3 次失败额度（**不按 nodeId 重置**） */
export const INVITE_MAX_ATTEMPTS = 3;
/** 协议版本（`/hub/info` 回给卫星，双方不一致就别继续） */
export const HUB_PROTOCOL_VERSION = 1;
/** 卫星心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 断线退避：1s 起，每次翻倍，60s 封顶 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** 邀请状态机：Created → Consumed / Expired / Exhausted / Revoked */
export type InvitationStatus = 'created' | 'consumed' | 'expired' | 'exhausted' | 'revoked';

/** 配对申请状态机：Pending → Approved / Rejected / Expired */
export type PairingRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** 成员关系状态机：Active → Revoked */
export type MembershipStatus = 'active' | 'revoked';

/**
 * 一个邀请。
 *
 * ⚠️ 不存明文码：`hmac` = HMAC-SHA256(serverKey, code)。节点 id 只用于审计展示，
 * **失败计数挂在本条邀请上**，与提交者是谁无关（否则换个 nodeId 就绕过，判据 3）。
 */
export interface Invitation {
    inviteId: string;
    /** 邀请绑定的域（判据 5） */
    domainId: DomainId;
    /** 建邀请的 Hub 节点（判据 5） */
    hubNodeId: NodeId;
    /** HMAC-SHA256(serverKey, code)，hex。字段名里刻意不带 "code"：落盘文件不该出现该词。
     *  `pinned-key` 协议不验码，故为空串。 */
    hmac: string;
    /** 邀请带的配对协议（缺失 = `code`，兼容 ##513 之前落盘的邀请） */
    protocol?: PairingProtocol;
    createdAt: string;
    expiresAt: string;
    /** 已失败次数（**按邀请全局**） */
    attempts: number;
    maxAttempts: number;
    status: InvitationStatus;
    /** 消费掉它的申请 id（并发消费时只有一个能写进来） */
    consumedByRequestId?: string;
    /**
     * 一键连接：邀请**自带授权** —— 卫星提交后立即批准，不走 pending。
     * 用户 2026-11-02 裁：「改成一键连接，最简单方式」。
     * 安全性：谁拿到链接谁就能加（链接有效期压到 60 秒）。
     */
    autoApprove?: boolean;
}

/** 一个待审批 / 已决的配对申请 */
export interface PairingRequest {
    requestId: string;
    domainId: DomainId;
    inviteId: string;
    nodeId: NodeId;
    displayName: string;
    /** 卫星的 Ed25519 公钥（base64 SPKI DER） */
    publicKey: string;
    status: PairingRequestStatus;
    requestedAt: string;
    decidedAt?: string;
}

/** 已配对的成员（Hub 侧只存 Token 的 SHA-256 / 卫星侧只在钥匙串里存 Token） */
export interface Membership {
    membershipId: MembershipId;
    domainId: DomainId;
    nodeId: NodeId;
    displayName: string;
    publicKey: string;
    /** SHA-256(token) hex —— **只在 Hub 侧**（判据 12） */
    tokenHash: string;
    status: MembershipStatus;
    createdAt: string;
    revokedAt?: string;
}

/** `peers.json` 的根 */
export interface PeerState {
    version: 1;
    domainId: DomainId;
    hubNodeId: NodeId;
    invitations: Invitation[];
    requests: PairingRequest[];
    memberships: Membership[];
}

/** `GET /hub/info` 的响应体：只含公开信息，**不含任何秘密** */
export interface HubInfo {
    protocolVersion: number;
    domainId: DomainId;
    hubNodeId: NodeId;
    /** Hub 的 Ed25519 公钥（base64 SPKI DER） */
    hubPublicKey: string;
}

/** Hub 的本地身份（私钥不在这里，在钥匙串） */
export interface HubIdentity {
    protocolVersion: number;
    domainId: DomainId;
    hubNodeId: NodeId;
    publicKey: string;
    /** 对外基址，形如 `https://c-mac.gute-fish.ts.net/hub`（邀请 URL 由它拼出） */
    endpoint?: string;
    createdAt: string;
}

/** 卫星侧 `link.json`：**只存非敏感信息**（判据 11：没有 token） */
export interface HubLink {
    version: 1;
    domainId: DomainId;
    hubNodeId: NodeId;
    hubPublicKey: string;
    hubEndpoint: string;
    /**
     * 协议 B（`pinned-key`）pin 住的主控公钥 —— 之后每次连接都要核对 `/hub/info` 的
     * `hubPublicKey` 与它一致，不一致 = 主控身份变了，拒连。
     */
    pinnedPublicKey?: string;
    /** pin 的时刻（`localISOString`） */
    pinnedAt?: string;
}

/**
 * 邀请链接的载荷：**就是真实 URL**（判据 6）。
 *
 *   https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123
 *
 * 人要比对的是 host（`c-mac.gute-fish.ts.net`）—— 不包 `diy://`，不编码。
 * 链接里**不含 code**（判据 2），domainId / hubNodeId 由 `/hub/info` 提供。
 */
export interface InvitePayload {
    /** Hub 基址（`https://host/hub`） */
    endpoint: string;
    inviteId: string;
    /** URL 里的 `p` 参数；缺失 = `code`（协议 A 的链接一个字节都不变） */
    protocol?: PairingProtocol;
}

/** `POST /hub/pair` 的请求体（这是**唯一**出现 code 的地方，且只在人输入后） */
export interface PairRequestBody {
    protocolVersion: number;
    inviteId: string;
    domainId: DomainId;
    /** 6 位码。`pinned-key` 协议不带码（可省 / 空串） */
    code?: string;
    nodeId: NodeId;
    displayName: string;
    publicKey: string;
    /** 等待审批的最长毫秒数（缺省 0 = 立即返回 pending；>0 时长轮询到批准 / 拒绝 / 超时） */
    waitMs?: number;
}

export interface PairSuccess {
    status: 'pending' | 'approved';
    requestId: string;
    /** 仅在 `status: 'approved'` 时出现；卫星拿到后**立刻进钥匙串** */
    token?: string;
    membershipId?: MembershipId;
    membership?: Membership;
}

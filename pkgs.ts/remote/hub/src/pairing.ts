// 审批：提交申请 → Owner 批准 → 签发 Token → 撤销（判据 4、10–13、16–17）。
//
// 两条不能含糊：
//   ① **未批准前卫星拿不到 Token**（判据 9）：`submitPairingRequest` 的返回里没有 token；
//      token 只在 `approveRequest` 内部生成**一次**，Hub 侧只留 SHA-256。
//   ② 申请里带 satellite 的公钥与 displayName，审批界面据此说「谁请求加入」。

import { localISOString } from '@diy-agent/time';
import { createPublicKey } from 'node:crypto';
import { consumeInvitationInState, expireStale } from './invitation.js';
import { HubError, type HubErrorCode } from './errors.js';
import { generateToken, newId, sha256Hex } from './key.js';
import type { HubStore } from './store.js';
import type { DomainId, Membership, NodeId, PairSuccess, PairingRequest, PeerState } from './types.js';

export interface PairingOptions {
    serverKey: string;
    now?: () => Date;
    tokenFactory?: () => string;
    randomId?: (prefix: string) => string;
}

export interface PairRequestInput {
    inviteId: string;
    domainId: DomainId;
    code: string;
    nodeId: NodeId;
    displayName: string;
    publicKey: string;
}

/** 卫星提交配对申请。**返回里没有 token**——批准之前谁都拿不到。 */
export async function submitPairingRequest(
    store: HubStore,
    opts: PairingOptions,
    input: PairRequestInput,
): Promise<PairSuccess> {
    assertEd25519PublicKey(input.publicKey);
    const now = opts.now?.() ?? new Date();
    const requestId = opts.randomId ? opts.randomId('req') : newId('req');

    const outcome = await store.update((state) => {
        expireStale(state, now);
        const consumed = consumeInvitationInState(
            state,
            { inviteId: input.inviteId, domainId: input.domainId, code: input.code, requestId },
            opts.serverKey,
            now,
        );
        if (!consumed.ok) {
            // 失败计数已在 state 上改过（attempts+1 / exhausted）—— 这里**不要**抛，
            // 否则 update 的持久化会被跳过。带出结果，外面再抛。
            return { ok: false as const, code: consumed.code, message: consumed.message };
        }

        const request: PairingRequest = {
            requestId,
            domainId: input.domainId,
            inviteId: input.inviteId,
            nodeId: input.nodeId,
            displayName: input.displayName,
            publicKey: input.publicKey,
            status: 'pending',
            requestedAt: localISOString(now),
        };
        state.requests.push(request);
        return { ok: true as const, request };
    });

    if (!outcome.ok) {
        throw new HubError(outcome.code as HubErrorCode, outcome.message);
    }
    // 判据 9：pending 就只回 requestId
    return { status: 'pending', requestId: outcome.request.requestId };
}

export interface ApprovalResult {
    token: string;
    membership: Membership;
    request: PairingRequest;
}

/** Owner 批准：生成 Token（只在这一次返回），Hub 只存 SHA-256。 */
export async function approveRequest(
    store: HubStore,
    requestId: string,
    opts: PairingOptions,
): Promise<ApprovalResult> {
    const now = opts.now?.() ?? new Date();
    const token = opts.tokenFactory ? opts.tokenFactory() : generateToken();
    const tokenHash = sha256Hex(token);

    const outcome = await store.update((state) => {
        const request = state.requests.find((r) => r.requestId === requestId);
        if (!request) {
            return { ok: false as const, code: 'pair/not-found' as HubErrorCode, message: '配对申请不存在' };
        }
        if (request.status !== 'pending') {
            return {
                ok: false as const,
                code: 'pair/not-pending' as HubErrorCode,
                message: `申请已是 ${request.status}`,
            };
        }

        // v1：每个 node 在一个域只有一条成员关系；旧的（若有）先撤销
        for (const m of state.memberships) {
            if (m.domainId === request.domainId && m.nodeId === request.nodeId && m.status === 'active') {
                m.status = 'revoked';
                m.revokedAt = localISOString(now);
            }
        }

        const membership: Membership = {
            membershipId: opts.randomId ? opts.randomId('mem') : newId('mem'),
            domainId: request.domainId,
            nodeId: request.nodeId,
            displayName: request.displayName,
            publicKey: request.publicKey,
            tokenHash,
            status: 'active',
            createdAt: localISOString(now),
        };
        state.memberships.push(membership);
        request.status = 'approved';
        request.decidedAt = localISOString(now);
        return { ok: true as const, request, membership };
    });

    if (!outcome.ok) {
        throw new HubError(outcome.code, outcome.message);
    }
    return { token, membership: outcome.membership, request: outcome.request };
}

export async function rejectRequest(
    store: HubStore,
    requestId: string,
    opts: { now?: () => Date } = {},
): Promise<PairingRequest> {
    const now = opts.now?.() ?? new Date();
    return store.update((state) => {
        const request = state.requests.find((r) => r.requestId === requestId);
        if (!request) throw new HubError('pair/not-found', '配对申请不存在');
        if (request.status !== 'pending') throw new HubError('pair/not-pending', `申请已是 ${request.status}`);
        request.status = 'rejected';
        request.decidedAt = localISOString(now);
        return request;
    });
}

/** 撤销成员关系（按 nodeId 或 membershipId）。返回被撤销的那条。 */
export async function revokeMembership(
    store: HubStore,
    target: { nodeId?: NodeId; membershipId?: string; domainId?: DomainId },
    opts: { now?: () => Date } = {},
): Promise<Membership> {
    const now = opts.now?.() ?? new Date();
    return store.update((state) => {
        const membership = state.memberships.find(
            (m) =>
                (target.membershipId ? m.membershipId === target.membershipId : m.nodeId === target.nodeId) &&
                (target.domainId === undefined || m.domainId === target.domainId) &&
                m.status === 'active',
        );
        if (!membership) throw new HubError('membership/not-found', '没有可撤销的成员关系');
        membership.status = 'revoked';
        membership.revokedAt = localISOString(now);
        return membership;
    });
}

/** 按 Token 认成员：只认 `status === 'active'`（判据 18：撤销后重连被拒）。 */
export async function authenticateToken(store: HubStore, token: string): Promise<Membership | null> {
    if (!token) return null;
    const hash = sha256Hex(token);
    const state = await store.read();
    return state.memberships.find((m) => m.status === 'active' && constantTimeEqualHex(m.tokenHash, hash)) ?? null;
}

export async function listPendingRequests(store: HubStore): Promise<PairingRequest[]> {
    const state = await store.read();
    return state.requests.filter((r) => r.status === 'pending');
}

export async function listMemberships(store: HubStore): Promise<Membership[]> {
    const state = await store.read();
    return state.memberships;
}

export function findRequest(state: PeerState, requestId: string): PairingRequest | undefined {
    return state.requests.find((r) => r.requestId === requestId);
}

function assertEd25519PublicKey(base64: string): void {
    let type: string | undefined;
    try {
        const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
        type = key.asymmetricKeyType;
    } catch {
        throw new HubError('hub/bad-input', 'publicKey 不是合法的 SPKI DER 公钥');
    }
    if (type !== 'ed25519') {
        throw new HubError('hub/bad-input', `公钥类型应为 ed25519，实际是 ${type}`);
    }
}

function constantTimeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

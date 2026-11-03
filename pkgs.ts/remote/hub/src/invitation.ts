// 邀请：建码（HMAC 落盘）/ 验码（全局失败计数）/ 原子消费（判据 1–5）。
//
// 三条硬约束在这里落地：
//   ① 码只以 HMAC-SHA256(serverKey, code) 落盘，不存明文、不用无盐 SHA；
//   ② 失败次数是**邀请自己的计数器**，提交者 nodeId 只进审计，绝不作为计数键；
//   ③ 「验码 + 置 consumed」必须在同一个 update 里（判据 4），先 read 再 update 会双开。

import { localISOString } from '@diy-agent/time';
import { newId, hmacSha256Hex, safeEqualHex } from './key.js';
import { generateInviteCode, normalizeInviteCode } from './code.js';
import { HubError, type HubErrorCode } from './errors.js';
import type { HubStore } from './store.js';
import {
    DEFAULT_DOMAIN_ID,
    INVITE_MAX_ATTEMPTS,
    INVITE_TTL_MS,
    type DomainId,
    type Invitation,
    type NodeId,
    type PeerState,
} from './types.js';

export interface InvitationOptions {
    /** HMAC 密钥（**Hub 私钥**；只在内存里用，不落盘） */
    serverKey: string;
    now?: () => Date;
    randomCode?: () => string;
    randomId?: (prefix: string) => string;
    ttlMs?: number;
    maxAttempts?: number;
}

export interface CreatedInvitation {
    invitation: Invitation;
    /** 明文的 6 位码 —— 只在这一刻返回给建邀请的人，服务端不保存 */
    code: string;
}

export async function createInvitation(
    store: HubStore,
    opts: InvitationOptions & { domainId?: DomainId; hubNodeId: NodeId; autoApprove?: boolean },
): Promise<CreatedInvitation> {
    const now = opts.now?.() ?? new Date();
    const ttl = opts.ttlMs ?? INVITE_TTL_MS;
    const maxAttempts = opts.maxAttempts ?? INVITE_MAX_ATTEMPTS;
    const code = opts.randomCode ? opts.randomCode() : generateInviteCode();
    const normalized = normalizeInviteCode(code);

    const invitation: Invitation = {
        inviteId: opts.randomId ? opts.randomId('inv') : newId('inv'),
        domainId: opts.domainId ?? DEFAULT_DOMAIN_ID,
        hubNodeId: opts.hubNodeId,
        hmac: hmacSha256Hex(opts.serverKey, normalized),
        createdAt: localISOString(now),
        expiresAt: localISOString(new Date(now.getTime() + ttl)),
        ...(opts.autoApprove === true ? { autoApprove: true } : {}),
        attempts: 0,
        maxAttempts,
        status: 'created',
    };

    await store.update((state) => {
        // 顺手把过期邀请标成 expired（不删：审计要看）
        expireStale(state, now);
        state.invitations.push(invitation);
    });

    return { invitation, code: normalized };
}

export type ConsumeResult = { ok: true; invitation: Invitation } | { ok: false; code: string; message: string };

/**
 * 在**已有 state**上验码并消费 —— 调用方必须已经在 `store.update` 里。
 *
 * 失败时**会修改 state**（attempts+1 / exhausted / expired），所以不能抛错后指望落盘：
 * 返回结果联合，由外层决定抛什么。
 */
export function consumeInvitationInState(
    state: PeerState,
    input: { inviteId: string; domainId: DomainId; code: string; requestId: string },
    serverKey: string,
    now: Date,
): ConsumeResult {
    const invitation = state.invitations.find((i) => i.inviteId === input.inviteId);
    if (!invitation) {
        return { ok: false, code: 'invite/not-found', message: '邀请不存在' };
    }
    // 判据 5：邀请绑定 domainId + hubNodeId
    if (invitation.domainId !== input.domainId || invitation.domainId !== state.domainId) {
        return { ok: false, code: 'hub/bad-input', message: `邀请不属于域 ${input.domainId}` };
    }
    if (invitation.hubNodeId !== state.hubNodeId) {
        return { ok: false, code: 'hub/bad-input', message: `邀请不属于本 Hub（${invitation.hubNodeId}）` };
    }
    if (invitation.status === 'consumed') {
        return { ok: false, code: 'invite/already-consumed', message: '邀请已被使用' };
    }
    if (invitation.status === 'revoked') {
        return { ok: false, code: 'invite/revoked', message: '邀请已撤销' };
    }
    if (invitation.status === 'exhausted') {
        return { ok: false, code: 'invite/exhausted', message: '邀请失败次数已用尽' };
    }
    if (invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= now.getTime()) {
        invitation.status = 'expired';
        return { ok: false, code: 'invite/expired', message: '邀请已过期' };
    }

    // ##一键连接：邀请自带授权（autoApprove）⇒ 不验码 —— inviteId 本身就是凭证（60 秒）。
    // 这条路径下 code 可以是空串，人也不需要从主控屏幕上抄 6 位码。
    if (invitation.autoApprove === true) {
        invitation.status = 'consumed';
        invitation.consumedByRequestId = input.requestId;
        return { ok: true, invitation };
    }

    let code: string;
    try {
        code = normalizeInviteCode(input.code);
    } catch {
        // 形态都不对也算一次失败（否则可以无限试）
        return recordFailure(invitation, '邀请码形态不对');
    }

    const expected = invitation.hmac;
    const actual = hmacSha256Hex(serverKey, code);
    if (!safeEqualHex(expected, actual)) {
        return recordFailure(invitation, '邀请码不正确');
    }

    // 原子消费：走到这里说明本次 update 拿到了这个邀请，别人排队在后面只会看到 consumed
    invitation.status = 'consumed';
    invitation.consumedByRequestId = input.requestId;
    return { ok: true, invitation };
}

function recordFailure(invitation: Invitation, message: string): ConsumeResult {
    invitation.attempts += 1;
    if (invitation.attempts >= invitation.maxAttempts) {
        invitation.status = 'exhausted';
    }
    return { ok: false, code: 'invite/bad-secret', message };
}

export function expireStale(state: PeerState, now: Date): void {
    for (const invitation of state.invitations) {
        if (invitation.status === 'created' && Date.parse(invitation.expiresAt) <= now.getTime()) {
            invitation.status = 'expired';
        }
    }
}

export function assertConsumed(result: ConsumeResult): Invitation {
    if (!result.ok) {
        throw new HubError(result.code as HubErrorCode, result.message);
    }
    return result.invitation;
}

export function findInvitation(state: PeerState, inviteId: string): Invitation | undefined {
    return state.invitations.find((i) => i.inviteId === inviteId);
}

export function pendingInvitations(state: PeerState): Invitation[] {
    return state.invitations.filter((i) => i.status === 'created');
}

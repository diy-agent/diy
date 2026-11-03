// 判据 10/12：未批准前拿不到 Token，Hub 侧只存 Token 哈希。
import { describe, expect, it } from 'vitest';
import { createInvitation } from '../src/invitation.js';
import { generateKeyPair, sha256Hex } from '../src/key.js';
import {
    approveRequest,
    authenticateToken,
    rejectRequest,
    revokeMembership,
    submitPairingRequest,
} from '../src/pairing.js';
import { testStore } from './helpers.js';
import { isHubError } from '../src/errors.js';

const serverKey = 'test-server-key';

async function setup() {
    const store = testStore('diy-hub01');
    const created = await createInvitation(store, { serverKey, hubNodeId: 'diy-hub01' });
    const pair = generateKeyPair();
    const submitted = await submitPairingRequest(
        store,
        { serverKey },
        {
            inviteId: created.invitation.inviteId,
            domainId: 'default',
            code: created.code,
            nodeId: 'diy-sat01',
            displayName: 'c-vn7',
            publicKey: pair.publicKey,
        },
    );
    return { store, created, pair, submitted };
}

describe('审批与 Token', () => {
    it('提交后只有 pending 申请，没有 token（判据 10）', async () => {
        const { store, submitted, pair } = await setup();
        expect(submitted.status).toBe('pending');
        expect(submitted.token).toBeUndefined();

        const state = await store.read();
        const request = state.requests[0]!;
        expect(request.status).toBe('pending');
        expect(request.displayName).toBe('c-vn7');
        expect(request.publicKey).toBe(pair.publicKey);
        expect(state.memberships).toHaveLength(0);
        expect(JSON.stringify(state)).not.toContain('tokenHash');
    });

    it('批准后拿 Token，state 里只有 SHA-256（判据 12）', async () => {
        const { store, submitted } = await setup();
        const approved = await approveRequest(store, submitted.requestId!, { serverKey });
        expect(approved.token).toHaveLength(43); // 32 字节 base64url

        const state = await store.read();
        expect(state.memberships).toHaveLength(1);
        expect(state.memberships[0]!.tokenHash).toBe(sha256Hex(approved.token));
        const raw = JSON.stringify(state);
        expect(raw).not.toContain(approved.token);

        const authed = await authenticateToken(store, approved.token);
        expect(authed?.nodeId).toBe('diy-sat01');
        expect(await authenticateToken(store, 'wrong-token')).toBeNull();
    });

    it('批准只能一次（重复批准报 not-pending）', async () => {
        const { store, submitted } = await setup();
        await approveRequest(store, submitted.requestId!, { serverKey });
        await expect(approveRequest(store, submitted.requestId!, { serverKey })).rejects.toSatisfy((e) =>
            isHubError(e, 'pair/not-pending'),
        );
    });

    it('拒绝后没有成员关系', async () => {
        const { store, submitted } = await setup();
        await rejectRequest(store, submitted.requestId!);
        const state = await store.read();
        expect(state.requests[0]!.status).toBe('rejected');
        expect(state.memberships).toHaveLength(0);
    });

    it('撤销后 Token 立刻失效（判据 17 的数据侧）', async () => {
        const { store, submitted } = await setup();
        const approved = await approveRequest(store, submitted.requestId!, { serverKey });
        await revokeMembership(store, { nodeId: 'diy-sat01' });
        expect(await authenticateToken(store, approved.token)).toBeNull();
        const state = await store.read();
        expect(state.memberships[0]!.status).toBe('revoked');
        expect(state.memberships[0]!.revokedAt).toBeTruthy();
    });

    it('非法公钥直接拒绝', async () => {
        const store = testStore();
        const created = await createInvitation(store, { serverKey, hubNodeId: 'diy-hub01' });
        await expect(
            submitPairingRequest(
                store,
                { serverKey },
                {
                    inviteId: created.invitation.inviteId,
                    domainId: 'default',
                    code: created.code,
                    nodeId: 'diy-sat01',
                    displayName: 'bad',
                    publicKey: 'not-a-key',
                },
            ),
        ).rejects.toSatisfy((e) => isHubError(e, 'hub/bad-input'));
    });
});

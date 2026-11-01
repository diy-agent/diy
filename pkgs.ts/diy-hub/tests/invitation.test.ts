// 判据 1/3/4/5/14：有效期、全局失败计数、并发消费、域绑定、HMAC 落盘。
import { afterEach, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/invitation.js';
import { generateKeyPair } from '../src/key.js';
import { submitPairingRequest } from '../src/pairing.js';
import { MemoryHubStore } from '../src/store.js';
import { FileHubStore } from '../src/store-fs.js';
import { isHubError } from '../src/errors.js';
import { cleanupTempDirs, tempDir, testStore } from './helpers.js';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

afterEach(cleanupTempDirs);

const serverKey = 'test-server-key-ed25519';

function newPairBody(inviteId: string, code: string, nodeId: string) {
    return { inviteId, domainId: 'default', code, nodeId, displayName: nodeId, publicKey: generateKeyPair().publicKey };
}

describe('邀请生命周期', () => {
    it('5 分钟有效，过期后拒绝（判据 1）', async () => {
        let now = new Date('2026-11-01T12:00:00.000+08:00');
        const store = testStore();
        const created = await createInvitation(store, { serverKey, now: () => now, hubNodeId: 'diy-hubtest01' });
        expect(created.invitation.expiresAt).toContain('+0800');

        now = new Date(now.getTime() + 5 * 60 * 1000 + 1);
        await expect(
            submitPairingRequest(
                store,
                { serverKey, now: () => now },
                newPairBody(created.invitation.inviteId, created.code, 'diy-sat01'),
            ),
        ).rejects.toSatisfy((e) => isHubError(e, 'invite/expired'));
    });

    it('失败次数按邀请全局计，换 nodeId 不重置（判据 3）', async () => {
        const store = testStore();
        const created = await createInvitation(store, { serverKey, hubNodeId: 'diy-hubtest01' });
        const bad = created.code === '000000' ? '111111' : '000000';

        for (const nodeId of ['diy-sat01', 'diy-sat02', 'diy-sat03']) {
            await expect(
                submitPairingRequest(store, { serverKey }, newPairBody(created.invitation.inviteId, bad, nodeId)),
            ).rejects.toSatisfy((e) => isHubError(e, 'invite/bad-secret'));
        }

        const state = await store.read();
        expect(state.invitations[0]!.attempts).toBe(3);
        expect(state.invitations[0]!.status).toBe('exhausted');
        // 次数用尽后，正确码也不能再用
        await expect(
            submitPairingRequest(
                store,
                { serverKey },
                newPairBody(created.invitation.inviteId, created.code, 'diy-sat04'),
            ),
        ).rejects.toSatisfy((e) => isHubError(e, 'invite/exhausted'));
    });

    it('并发消费同一邀请只有一个成功（判据 4，内存 store）', async () => {
        await expectConcurrentConsume(() => testStore());
    });

    it('并发消费同一邀请只有一个成功（判据 4，文件 store）', async () => {
        const file = join(tempDir(), 'peers.json');
        await expectConcurrentConsume(
            () => new FileHubStore({ file, domainId: 'default', hubNodeId: 'diy-hubtest01' }),
        );
    });

    it('邀请绑定 domainId + hubNodeId（判据 5）', async () => {
        const store = testStore();
        const created = await createInvitation(store, { serverKey, domainId: 'default', hubNodeId: 'diy-hubtest01' });
        expect(created.invitation.domainId).toBe('default');
        expect(created.invitation.hubNodeId).toBe('diy-hubtest01');

        const body = newPairBody(created.invitation.inviteId, created.code, 'diy-sat01');
        await expect(
            submitPairingRequest(store, { serverKey }, { ...body, domainId: 'other-domain' }),
        ).rejects.toSatisfy((e) => isHubError(e, 'hub/bad-input'));

        // 邀请的 hubNodeId 也必须与本机一致
        const foreign = await createInvitation(store, { serverKey, hubNodeId: 'diy-other-hub' });
        await expect(
            submitPairingRequest(
                store,
                { serverKey },
                newPairBody(foreign.invitation.inviteId, foreign.code, 'diy-sat02'),
            ),
        ).rejects.toSatisfy((e) => isHubError(e, 'hub/bad-input'));
    });

    it('落盘只有 HMAC，没有明文码（判据 14）', async () => {
        const dir = tempDir();
        const file = join(dir, 'peers.json');
        const store = new FileHubStore({ file, domainId: 'default', hubNodeId: 'diy-hubtest01' });
        const created = await createInvitation(store, { serverKey, hubNodeId: 'diy-hubtest01' });

        const raw = readFileSync(file, 'utf-8');
        expect(existsSync(file)).toBe(true);
        expect(raw).not.toContain(created.code);
        // 字段名也刻意不带 code：`grep -c code invites.json` 应为 0
        expect(raw.toLowerCase()).not.toContain('code');
        expect(JSON.parse(raw).invitations[0].hmac).toMatch(/^[0-9a-f]{64}$/);
    });
});

async function expectConcurrentConsume(makeStore: () => MemoryHubStore | FileHubStore): Promise<void> {
    const store = makeStore();
    const created = await createInvitation(store, { serverKey, hubNodeId: 'diy-hubtest01' });

    const results = await Promise.allSettled(
        ['diy-sat01', 'diy-sat02', 'diy-sat03'].map((nodeId) =>
            submitPairingRequest(store, { serverKey }, newPairBody(created.invitation.inviteId, created.code, nodeId)),
        ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const state = await store.read();
    expect(state.invitations[0]!.status).toBe('consumed');
    expect(state.requests).toHaveLength(1);
}

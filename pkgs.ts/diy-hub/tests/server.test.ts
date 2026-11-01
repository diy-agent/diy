// 端到端：邀请 → 卫星两步配对 → 批准 → WSS → 撤销断连 / 重连 403 / 重启自动重连。
import { afterEach, describe, expect, it } from 'vitest';
import { completePairing, HubClient, preparePairing } from '../src/client.js';
import { createHubServer, type HubServer } from '../src/server.js';
import { buildInviteUrl, normalizeHubEndpoint } from '../src/links.js';
import { cleanupTempDirs, testIdentity, testStore } from './helpers.js';

const servers: HubServer[] = [];
const clients: HubClient[] = [];

afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    for (const s of servers.splice(0)) await s.close();
    cleanupTempDirs();
});

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!(await pred())) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
        await new Promise((r) => setTimeout(r, 10));
    }
}

async function startHub(
    store = testStore('diy-hub01'),
): Promise<{ hub: HubServer; endpoint: string; privateKey: string }> {
    const { identity, privateKey } = testIdentity('diy-hub01');
    const hub = await createHubServer({
        identity,
        store,
        serverKey: privateKey,
        allowInsecureHttp: true, // 单测显式放行明文；生产必须 TLS（判据 9）
        host: '127.0.0.1',
        port: 0,
    });
    servers.push(hub);
    return { hub, endpoint: normalizeHubEndpoint(hub.url), privateKey };
}

describe('Hub 端到端', () => {
    it('地址 → 码 → 批准 → Token → WSS，撤销后断连 + 重连被拒', async () => {
        const { hub, endpoint } = await startHub();
        const invite = await hub.invite();
        const inviteUrl = buildInviteUrl({ endpoint, inviteId: invite.inviteId });

        // 判据 7：第一步拿到的是给人比对的地址
        const prepared = await preparePairing(inviteUrl, { allowInsecure: true });
        expect(prepared.address).toBe(new URL(endpoint).host);

        // 判据 10：pending 阶段还没有 Token（长轮询在批准前一直挂着）
        const waiting = completePairing(prepared, {
            code: invite.code,
            nodeId: 'diy-sat01',
            displayName: 'c-vn7',
            waitMs: 5000,
        });
        await waitFor(async () => (await hub.pending()).length === 1);
        const pending = await hub.pending();
        expect(pending[0]!.status).toBe('pending');

        const approval = await hub.approve(pending[0]!.requestId);
        expect(approval.token).toBeTruthy();

        const { result } = await waiting;
        expect(result.status).toBe('approved');
        expect(result.token).toBe(approval.token); // 长轮询同一次批准拿回同一个 Token

        const client = new HubClient({ hubEndpoint: endpoint, token: result.token!, heartbeatMs: 50 });
        clients.push(client);
        client.start();
        await waitFor(() => client.state === 'online');
        expect(hub.connectionCount('diy-sat01')).toBe(1);

        // 判据 16：撤销 → 现有连接断开
        await hub.revoke('diy-sat01');
        await waitFor(() => client.state === 'revoked');
        await waitFor(() => hub.connectionCount('diy-sat01') === 0);

        // 判据 17：重连被拒（403）
        const again = new HubClient({ hubEndpoint: endpoint, token: result.token!, heartbeatMs: 50 });
        clients.push(again);
        again.start();
        await waitFor(() => again.state === 'revoked');
    });

    it('hub 重启：同一份 peers.json，新进程 accept 同一个 Token（判据 19）', async () => {
        const store = testStore('diy-hub01');
        const first = await startHub(store);
        const invite = await first.hub.invite();
        const prepared = await preparePairing(buildInviteUrl({ endpoint: first.endpoint, inviteId: invite.inviteId }), {
            allowInsecure: true,
        });
        await completePairing(prepared, {
            code: invite.code,
            nodeId: 'diy-sat01',
            displayName: 'c-vn7',
        });
        const approval = await first.hub.approve((await first.hub.pending())[0]!.requestId);
        await first.hub.close();
        servers.length = 0;

        const second = await startHub(store);
        const client = new HubClient({
            hubEndpoint: second.endpoint,
            token: approval.token,
            heartbeatMs: 50,
        });
        clients.push(client);
        client.start();
        await waitFor(() => client.state === 'online');
    });

    it('错误码经 HTTP 透出（邀请过期 / 码错）', async () => {
        const { hub, endpoint } = await startHub();
        const invite = await hub.invite();
        const prepared = await preparePairing(buildInviteUrl({ endpoint, inviteId: invite.inviteId }), {
            allowInsecure: true,
        });
        const bad = invite.code === '000000' ? '111111' : '000000';
        await expect(completePairing(prepared, { code: bad, nodeId: 'diy-sat01', displayName: 'x' })).rejects.toThrow(
            /不正确/,
        );
    });
});

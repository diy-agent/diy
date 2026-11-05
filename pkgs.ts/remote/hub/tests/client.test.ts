// 判据 6/7/11/14：先显示地址再交码、link.json 无 token、卫星只连出。
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completePairing, persistPairing, preparePairing, reconnectDelay, type FetchLike } from '../src/client.js';
import { isHubError } from '../src/errors.js';
import { cleanupTempDirs, memorySecrets, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const info = {
    protocolVersion: 1,
    domainId: 'default',
    hubNodeId: 'diy-hub01',
    hubPublicKey: 'pubkey',
};

interface Call {
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

function recordingFetch(): { fetchImpl: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, init });
        const body = url.endsWith('/protocol') ? info : { status: 'pending', requestId: 'req_1' };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return { fetchImpl, calls };
}

describe('卫星配对两步', () => {
    const inviteUrl = 'https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123';

    it('第一步只取 /protocol，不发任何秘密（判据 6/7）', async () => {
        const { fetchImpl, calls } = recordingFetch();
        const prepared = await preparePairing(inviteUrl, { fetchImpl });

        expect(prepared.address).toBe('c-mac.gute-fish.ts.net');
        expect(prepared.inviteId).toBe('inv_abc123');
        expect(calls).toHaveLength(1);
        // 2026-11-05：完整协议信息挪到 `/protocol`（`/info` 降级为最小存活探针，不含身份）
        expect(calls[0]!.url).toBe('https://c-mac.gute-fish.ts.net/hub/protocol');
        expect(calls[0]!.init?.method).toBeUndefined(); // GET
        expect(calls[0]!.init?.body).toBeUndefined();
        // 第一步连 inviteId 都不发（它只在第二步的 POST body 里）
        expect(JSON.stringify(calls)).not.toContain('inv_abc123');
        expect(JSON.stringify(calls)).not.toContain('7K9MQ2');
    });

    it('第二步才发码；请求体里 code 只在这里出现', async () => {
        const { fetchImpl, calls } = recordingFetch();
        const prepared = await preparePairing(inviteUrl, { fetchImpl });
        const { result } = await completePairing(
            prepared,
            {
                code: '7K9MQ2',
                nodeId: 'diy-sat01',
                displayName: 'c-vn7',
            },
            { fetchImpl },
        );

        expect(result.status).toBe('pending');
        expect(calls).toHaveLength(2);
        const post = calls[1]!;
        expect(post.url).toBe('https://c-mac.gute-fish.ts.net/hub/pair');
        expect(post.init?.method).toBe('POST');
        const body = JSON.parse(post.init!.body!);
        expect(body.code).toBe('7K9MQ2');
        expect(body.domainId).toBe('default'); // 从 /hub/info 取，不靠人填
    });

    it('mDNS 地址在发请求之前就被拒（判据 8）', async () => {
        const { fetchImpl, calls } = recordingFetch();
        await expect(preparePairing('https://c-mac.local:3000/hub/pair?inv=inv_1', { fetchImpl })).rejects.toSatisfy(
            (e) => isHubError(e, 'pair/needs-tailscale'),
        );
        expect(calls).toHaveLength(0);
    });

    it('非 tailscale 地址默认拒绝，显式 allowInsecure 才放行', async () => {
        const { fetchImpl } = recordingFetch();
        await expect(preparePairing('http://127.0.0.1:9400/hub/pair?inv=inv_1', { fetchImpl })).rejects.toThrow();
        const prepared = await preparePairing('http://127.0.0.1:9400/hub/pair?inv=inv_1', {
            fetchImpl,
            allowInsecure: true,
        });
        expect(prepared.address).toBe('127.0.0.1:9400');
    });

    it('link.json 不含 token（判据 11），token 进钥匙串', async () => {
        const dir = tempDir();
        const linkFile = join(dir, 'link.json');
        const secrets = memorySecrets();
        const token = 'super-secret-token-value';
        const link = await persistPairing(
            { secrets, linkFile, endpoint: 'https://c-mac.gute-fish.ts.net/hub' },
            info,
            token,
        );

        const raw = readFileSync(linkFile, 'utf-8');
        expect(raw).not.toContain(token);
        expect(raw.toLowerCase()).not.toContain('token');
        expect(link.hubEndpoint).toBe('https://c-mac.gute-fish.ts.net/hub');
        expect(await secrets.get('token:diy-hub01')).toBe(token);
    });

    it('心跳 30s（判据 15）', async () => {
        const { HEARTBEAT_INTERVAL_MS } = await import('../src/types.js');
        expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it('退避 1s → 2s → … → 60s 封顶（判据 15）', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7].map(reconnectDelay)).toEqual([
            1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
        ]);
    });

    it('卫星侧代码里没有任何 listen / createServer（判据 14）', () => {
        const file = fileURLToPath(new URL('../src/client.ts', import.meta.url));
        const source = readFileSync(file, 'utf-8');
        expect(source).not.toMatch(/createServer\(|\.listen\(/);
        expect(source).not.toMatch(/from 'node:http'/);
    });
});

// 发现链：各发现器独立失败、结果合并去重、没有 id 的补 ping（判据 1 / 3 / 4）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAll } from '../src/node/discover.js';
import { startPingServer, type PingServerHandle } from '../src/node/ping-server.js';
import type { MdnsBrowser } from '../src/node/mdns.js';

const handles: PingServerHandle[] = [];
afterEach(async () => {
    while (handles.length > 0) await handles.pop()!.close();
});

const record = JSON.stringify({ pid: 111, pingPort: 9400, variant: 'lab', env: 'development', diyHome: '/tmp/lab' });

describe('discoverAll', () => {
    it('四路都能单独跑（manual 给输入时自动加入）且互相独立', async () => {
        const result = await discoverAll({
            sources: ['local', 'mdns', 'tailscale', 'manual'],
            manual: ['10.0.0.9'],
            enrich: false,
            local: {
                dir: '/fake',
                listFiles: () => ['111.json'],
                readFile: () => record,
                ping: async () => ({
                    ok: true,
                    info: {
                        id: 'diy-aaaa1111',
                        displayName: '本机 lab',
                        variant: 'lab',
                        version: '0.1.0',
                        pid: 111,
                        startedAt: '2026-10-31T00:00:00.000Z',
                        uptimeMs: 1,
                    },
                }),
            },
            mdnsBrowser: {
                browse: async () => [
                    {
                        name: '本机 lab',
                        host: 'c-mac.local.',
                        port: 9400,
                        addresses: ['192.168.1.5'],
                        txt: { id: 'diy-aaaa1111', variant: 'lab' },
                    },
                ],
            },
            tailscale: {
                run: async () =>
                    JSON.stringify({ Peer: { a: { HostName: 'srv', TailscaleIPs: ['100.64.0.2'], Online: true } } }),
                ping: async (endpoint) =>
                    endpoint === 'http://100.64.0.2:9400'
                        ? {
                              ok: true,
                              info: {
                                  id: 'diy-bbbb2222',
                                  displayName: '服务器 prod',
                                  variant: 'prod',
                                  version: '0.1.0',
                                  pid: 2,
                                  startedAt: '2026-10-31T00:00:00.000Z',
                                  uptimeMs: 1,
                              },
                          }
                        : { ok: false, info: null },
            },
        });

        expect(result.errors).toEqual([]);
        // manual 那个地址 enrich:false 且没人应答 → 仍作为一行保留（用户手输不丢弃）；manual 优先级最高故排第一
        expect(result.items.map((r) => r.id)).toEqual([null, 'diy-aaaa1111', 'diy-bbbb2222']);
        const local = result.items.find((r) => r.id === 'diy-aaaa1111')!;
        expect(local.sources).toEqual(['local', 'mdns']); // 同一实例两路看到 → 一行
    });

    it('某一路炸了只记 error，不影响别的路', async () => {
        const badBrowser: MdnsBrowser = {
            browse: async () => {
                throw new Error('多播不可用');
            },
        };
        const result = await discoverAll({
            sources: ['local', 'mdns', 'tailscale'],
            enrich: false,
            local: {
                dir: '/fake',
                listFiles: () => [],
                readFile: () => null,
                ping: async () => ({ ok: false, info: null }),
            },
            mdnsBrowser: badBrowser,
            tailscale: { run: async () => null, ping: async () => ({ ok: false, info: null }) },
        });
        expect(result.errors).toEqual([{ source: 'mdns', message: '多播不可用' }]);
        expect(result.items).toEqual([]);
    });

    it('tailscale 没装 → 静默跳过（不是 error）', async () => {
        const result = await discoverAll({
            sources: ['tailscale'],
            enrich: false,
            tailscale: { run: async () => null },
        });
        expect(result).toEqual({ items: [], errors: [] });
    });

    it('没有 id 的候选补一次 /ping 拿身份（enrich 缺省开）', async () => {
        const server = await startPingServer({
            identity: { id: 'diy-eeee5555', displayName: '手动连上的实例' },
            variant: 'lab',
            version: '0.1.0',
            host: '127.0.0.1',
            port: 0,
        });
        handles.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'diy-remote-reg-'));
        try {
            writeFileSync(
                join(dir, '1.json'),
                JSON.stringify({
                    pid: process.pid,
                    pingPort: server.port,
                    variant: 'lab',
                    env: 'test',
                    diyHome: '/tmp',
                }),
            );
            const result = await discoverAll({
                sources: ['manual', 'local'],
                manual: [`http://127.0.0.1:${server.port}`],
                registryDir: dir,
            });
            expect(result.items).toHaveLength(1);
            expect(result.items[0]?.id).toBe('diy-eeee5555');
            expect(result.items[0]?.displayName).toBe('手动连上的实例');
            // 已由 local 路给出 id ⇒ 不需要补 ping（reachable 只在「原本没有 id」时才标）
            // 补完身份后**再合并一遍**：两路的 sources 都必须在（跨来源证据不能丢）
            expect(result.items[0]?.sources).toEqual(['manual', 'local']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('补 ping 打不通 → 仍保留该行，标 reachable=false', async () => {
        const result = await discoverAll({
            sources: ['manual'],
            manual: ['http://127.0.0.1:1'],
            pingTimeoutMs: 200,
            enrich: true,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.id).toBeNull();
        expect(result.items[0]?.meta?.['reachable']).toBe('false');
    });
});

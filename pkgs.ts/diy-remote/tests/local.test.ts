// local 发现器：扫注册表 → 只收 ping 得通的（判据：文件只说明「它启动时这么想」）。
import { describe, expect, it } from 'vitest';
import { localDiscoverer, parseRegistryRecord } from '../src/node/local.js';
import type { PingInfo } from '../src/types.js';

const info = (patch: Partial<PingInfo>): PingInfo => ({
    id: 'diy-aaaa1111',
    displayName: 'c-mac 的 lab',
    variant: 'lab',
    version: '0.1.0',
    pid: 111,
    startedAt: '2026-10-31T00:00:00.000Z',
    uptimeMs: 1000,
    ...patch,
});

describe('parseRegistryRecord', () => {
    it('有 pingPort + pid 才算数', () => {
        expect(
            parseRegistryRecord({ pid: 1, pingPort: 9400, variant: 'lab', env: 'development', diyHome: '/x' }),
        ).toEqual({
            pingPort: 9400,
            pid: 1,
            variant: 'lab',
            env: 'development',
            diyHome: '/x',
        });
        expect(parseRegistryRecord({ pid: 1 })).toBeNull(); // 老实例：没有 pingPort
        expect(parseRegistryRecord({ pid: 1, pingPort: 0 })).toBeNull();
        expect(parseRegistryRecord({ pid: 1, pingPort: 9400 })).not.toBeNull();
        expect(parseRegistryRecord(null)).toBeNull();
    });
});

describe('localDiscoverer', () => {
    const files: Record<string, string> = {
        '111.json': JSON.stringify({
            pid: 111,
            pingPort: 9400,
            variant: 'lab',
            env: 'development',
            diyHome: '/tmp/lab',
        }),
        '222.json': JSON.stringify({ pid: 222, port: 18888 }), // 老实例：无 pingPort
        '333.json': '{ 这不是 JSON',
        'note.txt': '不是记录',
    };

    it('只收 ping 得通的那条，附带 pid/variant 证据', async () => {
        const d = localDiscoverer({
            dir: '/fake/.diy-instances',
            listFiles: () => Object.keys(files),
            readFile: (f) => files[f.split('/').pop() ?? ''] ?? null,
            ping: async (endpoint) =>
                endpoint === 'http://127.0.0.1:9400' ? { ok: true, info: info({}) } : { ok: false, info: null },
        });
        const items = await d.discover();
        expect(items).toEqual([
            {
                id: 'diy-aaaa1111',
                displayName: 'c-mac 的 lab',
                endpoint: 'http://127.0.0.1:9400',
                source: 'local',
                meta: { pid: '111', variant: 'lab', env: 'development', diyHome: '/tmp/lab' },
            },
        ]);
    });

    it('ping 不通 = 不列（进程卡死 / 端口已关的条目是假象）', async () => {
        const d = localDiscoverer({
            dir: '/fake',
            listFiles: () => ['111.json'],
            readFile: () => files['111.json'] ?? null,
            ping: async () => ({ ok: false, info: null }),
        });
        expect(await d.discover()).toEqual([]);
    });

    it('目录不存在 → 空表（第一次跑，不是错误）', async () => {
        const d = localDiscoverer({ dir: '/definitely-not-here', listFiles: () => [], readFile: () => null });
        expect(await d.discover()).toEqual([]);
    });
});

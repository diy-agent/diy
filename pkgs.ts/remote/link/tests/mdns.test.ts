// mDNS 发现器：服务记录 → 候选（TXT 带 id/displayName 就带上）。
import { describe, expect, it } from 'vitest';
import { mdnsDiscoverer, recordToInstance, type MdnsServiceRecord } from '../src/node/mdns.js';

const rec = (patch: Partial<MdnsServiceRecord>): MdnsServiceRecord => ({
    name: 'c-mac 的 lab',
    host: 'c-mac.local.',
    port: 9400,
    addresses: ['192.168.1.5'],
    txt: {},
    ...patch,
});

describe('recordToInstance', () => {
    it('TXT 里的 id / displayName / variant 都带上', () => {
        const item = recordToInstance(
            rec({ txt: { id: 'diy-7f3a2c91', displayName: 'c-mac 的 lab 实例', variant: 'lab' } }),
        );
        expect(item).toEqual({
            id: 'diy-7f3a2c91',
            displayName: 'c-mac 的 lab 实例',
            endpoint: 'http://c-mac.local:9400',
            source: 'mdns',
            meta: { variant: 'lab' },
        });
    });

    it('没有 TXT 时 id 为 null，displayName 退化到服务名', () => {
        const item = recordToInstance(rec({}));
        expect(item?.id).toBeNull();
        expect(item?.displayName).toBe('c-mac 的 lab');
    });

    it('host 为空时用第一条地址；端口非法 → null', () => {
        expect(recordToInstance(rec({ host: '', addresses: ['10.0.0.7'] }))?.endpoint).toBe('http://10.0.0.7:9400');
        expect(recordToInstance(rec({ port: 0 }))).toBeNull();
    });

    it('IPv6 地址加方括号', () => {
        expect(recordToInstance(rec({ host: 'fd7a::2' }))?.endpoint).toBe('http://[fd7a::2]:9400');
    });
});

describe('mdnsDiscoverer', () => {
    it('浏览结果逐条映射；空结果 = 空列表（不报错）', async () => {
        const items = await mdnsDiscoverer({
            browser: { browse: async () => [rec({ txt: { id: 'diy-1' }, name: '某服务' })] },
            timeoutMs: 10,
        }).discover();
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe('diy-1');

        const empty = await mdnsDiscoverer({ browser: { browse: async () => [] }, timeoutMs: 10 }).discover();
        expect(empty).toEqual([]);
    });
});

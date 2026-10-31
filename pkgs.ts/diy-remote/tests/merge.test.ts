// 合并去重：同一实例被多路发现只出现一行（##479 判据 4）。
import { describe, expect, it } from 'vitest';
import { mergeDiscovered, normalizeEndpoint } from '../src/merge.js';
import type { DiscoveredInstance } from '../src/types.js';

const item = (patch: Partial<DiscoveredInstance>): DiscoveredInstance => ({
    id: null,
    displayName: null,
    endpoint: 'http://127.0.0.1:9400',
    source: 'local',
    ...patch,
});

describe('normalizeEndpoint', () => {
    it('补 scheme、去尾部斜杠、host 小写、保留端口', () => {
        expect(normalizeEndpoint('192.168.1.5:9400/')).toBe('http://192.168.1.5:9400');
        expect(normalizeEndpoint('http://Host.Local:9400///')).toBe('http://host.local:9400');
        expect(normalizeEndpoint('https://srv.tailnet:9400')).toBe('https://srv.tailnet:9400');
    });
    it('非法 / 空 / 非 http(s) → null', () => {
        expect(normalizeEndpoint('')).toBeNull();
        expect(normalizeEndpoint('   ')).toBeNull();
        expect(normalizeEndpoint('ftp://x:1')).toBeNull();
    });
});

describe('mergeDiscovered', () => {
    it('同一个 id 的两路结果合成一行，sources 按优先级排', () => {
        const rows = mergeDiscovered([
            item({ id: 'diy-aaaa', displayName: 'c-mac lab', endpoint: 'http://192.168.1.5:9400', source: 'mdns' }),
            item({ id: 'diy-aaaa', displayName: 'c-mac lab', endpoint: 'http://127.0.0.1:9400', source: 'local' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sources).toEqual(['local', 'mdns']);
        // 端点取来源优先级靠前的那个（local < mdns）
        expect(rows[0]?.endpoint).toBe('http://127.0.0.1:9400');
    });

    it('没有 id 时按 endpoint 合并，后到的 id 会补上', () => {
        const rows = mergeDiscovered([
            item({ endpoint: 'http://1.2.3.4:9400', source: 'mdns' }),
            item({ id: 'diy-bbbb', displayName: 'srv', endpoint: 'http://1.2.3.4:9400/', source: 'manual' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe('diy-bbbb');
        expect(rows[0]?.displayName).toBe('srv');
        expect(rows[0]?.sources).toEqual(['manual', 'mdns']);
    });

    it('manual 手输压过自动发现（端点不被覆盖）', () => {
        const rows = mergeDiscovered([
            item({ id: 'diy-cccc', endpoint: 'http://10.0.0.9:9400', source: 'tailscale' }),
            item({ id: 'diy-cccc', endpoint: 'http://my-alias:9400', source: 'manual' }),
        ]);
        expect(rows[0]?.endpoint).toBe('http://my-alias:9400');
        expect(rows[0]?.source).toBe('manual');
    });

    it('不同 id 各自成行；非法 endpoint 丢弃', () => {
        const rows = mergeDiscovered([
            item({ id: 'diy-1111', endpoint: 'http://a:9400' }),
            item({ id: 'diy-2222', endpoint: 'http://b:9400' }),
            item({ id: 'diy-3333', endpoint: '' }),
        ]);
        expect(rows.map((r) => r.id).sort()).toEqual(['diy-1111', 'diy-2222']);
    });

    it('输出顺序稳定（来源优先级 → 显示名）', () => {
        const rows = mergeDiscovered([
            item({ id: 'diy-z', displayName: 'z', endpoint: 'http://z:9400', source: 'mdns' }),
            item({ id: 'diy-a', displayName: 'a', endpoint: 'http://a:9400', source: 'mdns' }),
            item({ id: 'diy-m', displayName: 'm', endpoint: 'http://m:9400', source: 'manual' }),
        ]);
        expect(rows.map((r) => r.displayName)).toEqual(['m', 'a', 'z']);
    });

    it('重新合并已合并的行不丢 sources（discoverAll 补身份后会再合并一遍）', () => {
        const once = mergeDiscovered([
            item({ id: 'diy-ee', endpoint: 'http://x:9400', source: 'local' }),
            item({ id: 'diy-ee', endpoint: 'http://x:9400', source: 'mdns' }),
        ]);
        expect(once[0]?.sources).toEqual(['local', 'mdns']);
        const twice = mergeDiscovered(once);
        expect(twice).toHaveLength(1);
        expect(twice[0]?.sources).toEqual(['local', 'mdns']);
    });

    it('meta 合并（后到的键覆盖同名的）', () => {
        const rows = mergeDiscovered([
            item({ id: 'diy-d', endpoint: 'http://d:9400', source: 'mdns', meta: { variant: 'lab', host: 'x' } }),
            item({ id: 'diy-d', endpoint: 'http://d:9400', source: 'local', meta: { variant: 'lab', pid: '42' } }),
        ]);
        expect(rows[0]?.meta).toEqual({ variant: 'lab', host: 'x', pid: '42' });
    });
});

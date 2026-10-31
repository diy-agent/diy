import { describe, expect, it } from 'vitest';
import { discoverInstances, type RemoteNodeModule } from '../discover.js';

describe('发现器适配层（##479 的包在不在都要能用）', () => {
    it('包不在（当前 main 的现状）⇒ 只回 manual 候选，不报错', async () => {
        const result = await discoverInstances({
            manual: ['127.0.0.1:8080'],
            load: async () => null,
        });
        expect(result.errors).toEqual([]);
        expect(result.items).toEqual([
            { id: null, displayName: null, endpoint: 'http://127.0.0.1:8080', source: 'manual' },
        ]);
    });

    it('包在了 ⇒ 用它的 discoverAll，manual 也一起带上，errors 原样透传', async () => {
        const fake: RemoteNodeModule = {
            discoverAll: async (options) => ({
                items: [
                    { id: 'diy-1', displayName: 'c-mac', endpoint: 'http://10.0.0.5:9400', source: 'mdns' },
                    ...(options.manual ?? []).map((endpoint) => ({
                        id: null,
                        displayName: null,
                        endpoint,
                        source: 'manual',
                    })),
                ],
                errors: [{ source: 'tailscale', message: '没装 tailscale' }],
            }),
        };
        const result = await discoverInstances({ manual: ['http://127.0.0.1:8080'], load: async () => fake });
        expect(result.errors).toEqual([{ source: 'tailscale', message: '没装 tailscale' }]);
        expect(result.items.map((item) => item.source).sort()).toEqual(['manual', 'manual', 'mdns']);
    });

    it('发现链整体抛错 ⇒ 记一条 error 但 manual 候选照旧返回（横条不能空）', async () => {
        const fake: RemoteNodeModule = {
            discoverAll: async () => {
                throw new Error('mDNS 崩了');
            },
        };
        const result = await discoverInstances({ manual: ['http://127.0.0.1:8080'], load: async () => fake });
        expect(result.items).toHaveLength(1);
        expect(result.errors[0]?.source).toBe('remote');
        expect(result.errors[0]?.message).toContain('mDNS 崩了');
    });

    it('包的导出形状不对（没有 discoverAll）也算「不在」', async () => {
        const result = await discoverInstances({ manual: [], load: async () => ({}) });
        expect(result).toEqual({ items: [], errors: [] });
    });
});

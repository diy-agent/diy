// 判据 2/6/8：真实主机地址、不含 code、mDNS 不能配对。
import { describe, expect, it } from 'vitest';
import {
    assertPairableAddress,
    buildDiscoveryTxt,
    buildInviteUrl,
    displayAddress,
    normalizeHubEndpoint,
    parseInviteUrl,
} from '../src/links.js';
import { isHubError } from '../src/errors.js';

describe('邀请地址', () => {
    it('是真实主机形式，不是 diy:// 包装（判据 6）', () => {
        const url = buildInviteUrl({ endpoint: 'https://c-mac.gute-fish.ts.net/hub', inviteId: 'inv_abc123' });
        expect(url).toBe('https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123');
        expect(url).not.toContain('diy://');
        expect(url).not.toContain('endpoint=');
    });

    it('链接不含 code（判据 2）', () => {
        const url = buildInviteUrl({ endpoint: 'https://c-mac.gute-fish.ts.net/hub', inviteId: 'inv_abc123' });
        expect(url.toLowerCase()).not.toContain('code');
    });

    it('地址归一 + 往返解析', () => {
        expect(normalizeHubEndpoint('c-mac.gute-fish.ts.net')).toBe('https://c-mac.gute-fish.ts.net/hub');
        expect(normalizeHubEndpoint('https://host/hub/')).toBe('https://host/hub');
        const url = buildInviteUrl({ endpoint: 'https://host/hub', inviteId: 'inv_1' });
        expect(parseInviteUrl(url)).toEqual({ endpoint: 'https://host/hub', inviteId: 'inv_1' });
    });

    it('给人看的只有 host', () => {
        expect(displayAddress('https://c-mac.gute-fish.ts.net/hub')).toBe('c-mac.gute-fish.ts.net');
    });

    it('拒绝 mDNS / 非 tailscale 地址（判据 8）', () => {
        expect(() => assertPairableAddress('https://c-mac.local:3000/hub')).toThrow(/tailscale/);
        try {
            assertPairableAddress('https://c-mac.local:3000/hub');
        } catch (e) {
            expect(isHubError(e, 'pair/needs-tailscale')).toBe(true);
        }
        expect(() => assertPairableAddress('http://192.168.1.5:9400/hub')).toThrow();
        expect(() => assertPairableAddress('https://c-mac.gute-fish.ts.net/hub')).not.toThrow();
        // 单测显式放行
        expect(() => assertPairableAddress('http://127.0.0.1:1234/hub', { allowInsecure: true })).not.toThrow();
    });

    it('mDNS TXT 只做发现展示，不含公钥 / 指纹', () => {
        const txt = buildDiscoveryTxt({ nodeId: 'diy-sat01', displayName: 'c-vn7', variant: 'prod' });
        const raw = JSON.stringify(txt).toLowerCase();
        expect(raw).not.toContain('fingerprint');
        expect(raw).not.toContain('publickey');
    });
});

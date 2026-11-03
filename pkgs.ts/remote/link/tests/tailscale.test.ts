// tailscale status --json 的解析（纯函数，不装 tailscale 也能测）。
import { describe, expect, it } from 'vitest';
import { parseTailscaleStatus, peerEndpoints } from '../src/discover/tailscale.js';

const status = {
    Self: { HostName: 'me', DNSName: 'me.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] },
    Peer: {
        'nodekey:1': {
            HostName: 'srv',
            DNSName: 'srv.tailnet.ts.net.',
            TailscaleIPs: ['100.64.0.2', 'fd7a::2'],
            Online: true,
        },
        'nodekey:2': { HostName: 'offline-box', TailscaleIPs: ['100.64.0.3'], Online: false },
        'nodekey:3': { DNSName: 'only-dns.tailnet.ts.net.' },
    },
};

describe('parseTailscaleStatus', () => {
    it('不含 Self（自己由 local 发现器负责）', () => {
        expect(parseTailscaleStatus(status).map((p) => p.hostName)).toEqual([
            'srv',
            'offline-box',
            'only-dns.tailnet.ts.net',
        ]);
    });

    it('DNSName 去尾部点；IPv4 排在 IPv6 前', () => {
        const peer = parseTailscaleStatus(status)[0]!;
        expect(peer.dnsName).toBe('srv.tailnet.ts.net');
        expect(peer.ips).toEqual(['100.64.0.2', 'fd7a::2']);
        expect(peer.online).toBe(true);
    });

    it('没有 Online 字段当作在线（交给探测否证）；没有 HostName 用 DNSName 顶', () => {
        const peers = parseTailscaleStatus(status);
        expect(peers[1]?.online).toBe(false);
        expect(peers[2]?.hostName).toBe('only-dns.tailnet.ts.net');
    });

    it('坏输入 → 空数组', () => {
        expect(parseTailscaleStatus(null)).toEqual([]);
        expect(parseTailscaleStatus({ Peer: null })).toEqual([]);
        expect(parseTailscaleStatus('nope')).toEqual([]);
    });
});

describe('peerEndpoints', () => {
    it('DNSName 优先，最多 3 个；IPv6 加方括号', () => {
        const eps = peerEndpoints(
            { hostName: 'srv', dnsName: 'srv.tailnet', ips: ['100.64.0.2', 'fd7a::2'], online: true },
            9400,
        );
        expect(eps).toEqual(['http://srv.tailnet:9400', 'http://100.64.0.2:9400', 'http://[fd7a::2]:9400']);
    });
});

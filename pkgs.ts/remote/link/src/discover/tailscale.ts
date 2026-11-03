// tailscale 发现器的**纯解析**部分：把 `tailscale status --json` 的输出变成可探测的 peer 列表。
//
// 为什么要单独拆：真跑 CLI 属于 node 侧 IO（node/tailscale.ts）；这里只吃 JSON —— 于是
// 「字段大小写 / DNSName 末尾点 / 只有 IPv6 / 离线」这些分支都能喂桩单测，不用装 tailscale。

/** 一个 tailnet 上的节点（只保留发现需要的字段） */
export interface TailscalePeer {
    /** 机器短名（Tailscale 的 HostName） */
    hostName: string;
    /** MagicDNS 全名（已去尾部点）；没有则 null */
    dnsName: string | null;
    /** TailscaleIPs，IPv4 在前（探测优先 IPv4：IPv6 在部分网络不通） */
    ips: string[];
    /** 是否在线（旧版没有该字段 = 当作在线，交给探测去否证） */
    online: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseNode(raw: unknown): TailscalePeer | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const dnsRaw = str(o['DNSName']);
    const dnsName = dnsRaw === null ? null : dnsRaw.replace(/\.$/, '');
    const hostName = str(o['HostName']) ?? dnsName ?? str(o['ID']);
    if (hostName === null) return null;
    const ipsRaw = Array.isArray(o['TailscaleIPs']) ? (o['TailscaleIPs'] as unknown[]) : [];
    const ips = ipsRaw
        .filter((ip): ip is string => typeof ip === 'string' && ip.trim() !== '')
        .map((ip) => ip.trim())
        .sort((a, b) => Number(IPV4.test(b)) - Number(IPV4.test(a)));
    const online = typeof o['Online'] === 'boolean' ? o['Online'] : true;
    return { hostName, dnsName, ips, online };
}

/**
 * 解析 `tailscale status --json`。**不含 Self**：自己那台由 local 发现器负责，
 * 混进来会让用户在列表里看到「自己」（判据 4 的列表是「别的实例」）。
 * Peer 既可能是对象（nodekey → 节点），也可能是数组（极老版本）—— 两种都收。
 */
export function parseTailscaleStatus(json: unknown): TailscalePeer[] {
    if (typeof json !== 'object' || json === null) return [];
    const peersRaw = (json as Record<string, unknown>)['Peer'];
    const values: unknown[] = Array.isArray(peersRaw)
        ? (peersRaw as unknown[])
        : typeof peersRaw === 'object' && peersRaw !== null
          ? Object.values(peersRaw as Record<string, unknown>)
          : [];
    const out: TailscalePeer[] = [];
    for (const value of values) {
        const peer = parseNode(value);
        if (peer !== null) out.push(peer);
    }
    return out;
}

/** 一个 peer 的可探测基址（DNSName 优先：它不随 IP 变；再按 IP 顺序补齐），最多 `limit` 个 */
export function peerEndpoints(peer: TailscalePeer, port: number, limit = 3): string[] {
    const hosts = [...(peer.dnsName !== null ? [peer.dnsName] : []), ...peer.ips];
    return hosts.slice(0, limit).map((host) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

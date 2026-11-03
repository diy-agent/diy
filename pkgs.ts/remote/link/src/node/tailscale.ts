// tailscale 发现器：走 tailnet 的机器名 / IP 找同网段的 diy 实例。
//
// 判据（##479）：
//   · **没装 tailscale 就静默跳过**（不报错、不刷屏）—— 这是可选发现器，不是依赖。
//   · 只探测 `online` 的 peer，且只探缺省 ping 端口（9400）：不做全端口扫描。
//   · 一台 peer 的多个地址（MagicDNS 名 / IPv4 / IPv6）逐个试，命中即止（DNSName 优先）。

import { execFile } from 'node:child_process';
import type { DiscoveredInstance, Discoverer, PingInfo } from '../types.js';
import { PING_DEFAULT_PORT } from '../types.js';
import { parseTailscaleStatus, peerEndpoints, type TailscalePeer } from '../discover/tailscale.js';
import { fetchPing } from './ping-client.js';

export interface TailscaleDiscoverDeps {
    /** 跑 CLI；返回 stdout；`null` = 不可用（没装 / 超时 / 非零退出） */
    run?: (args: string[], timeoutMs: number) => Promise<string | null>;
    ping?: (endpoint: string, timeoutMs: number) => Promise<{ ok: boolean; info: PingInfo | null }>;
    /** 探测哪个端口（缺省 9400） */
    port?: number;
    /** 单次 ping 超时 */
    timeoutMs?: number;
    /** tailscale CLI 命令（可在测试里换掉） */
    command?: string;
}

/** 跑一次 tailscale CLI（默认实现：`tailscale status --json`） */
export function runTailscaleCli(command = 'tailscale'): (args: string[], timeoutMs: number) => Promise<string | null> {
    return (args, timeoutMs) =>
        new Promise((resolve) => {
            execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
                // ENOENT（没装）/ 超时 / 非零退出 一律当作不可用 —— 静默跳过是本发现器的明确契约
                resolve(err ? null : stdout);
            });
        });
}

export function tailscaleDiscoverer(deps: TailscaleDiscoverDeps = {}): Discoverer {
    const run = deps.run ?? runTailscaleCli(deps.command ?? 'tailscale');
    const ping = deps.ping ?? fetchPing;
    const port = deps.port ?? PING_DEFAULT_PORT;
    const timeoutMs = deps.timeoutMs ?? 900;

    return {
        kind: 'tailscale',
        discover: async () => {
            const out = await run(['status', '--json'], 4000);
            if (out === null || out.trim() === '') return [];
            let parsed: unknown;
            try {
                parsed = JSON.parse(out);
            } catch {
                return [];
            }
            const peers = parseTailscaleStatus(parsed).filter((p) => p.online);
            const results = await Promise.all(peers.map((peer) => probePeer(peer, port, timeoutMs, ping)));
            return results.filter((r): r is DiscoveredInstance => r !== null);
        },
    };
}

async function probePeer(
    peer: TailscalePeer,
    port: number,
    timeoutMs: number,
    ping: (endpoint: string, timeoutMs: number) => Promise<{ ok: boolean; info: PingInfo | null }>,
): Promise<DiscoveredInstance | null> {
    for (const endpoint of peerEndpoints(peer, port)) {
        const r = await ping(endpoint, timeoutMs);
        if (r.ok && r.info !== null) {
            return {
                id: r.info.id,
                displayName: r.info.displayName,
                endpoint,
                source: 'tailscale',
                meta: {
                    host: peer.hostName,
                    ...(peer.dnsName !== null ? { dnsName: peer.dnsName } : {}),
                    variant: r.info.variant,
                },
            };
        }
    }
    return null;
}

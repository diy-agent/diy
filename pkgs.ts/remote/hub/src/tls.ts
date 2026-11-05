// TLS：v1 **只支持受信任的 HTTPS**（tailscale cert 之类），**不做自签证书 pinning**。
//
// 判据 8：拿不到证书时**明确报错**，不静默降级成 http。
// 静默降级最坏：卫星以为在核对指纹，实际连接可被中间人替换 —— 错得没有声音。

import { existsSync, readFileSync } from 'node:fs';
import { HubError } from './errors.js';

export interface TlsMaterial {
    key: string;
    cert: string;
}

export interface TlsSources {
    certPath?: string;
    keyPath?: string;
    env?: NodeJS.ProcessEnv;
}

/**
 * 解析证书：
 *   ① 显式参数（`diy hub init --tls-cert/--tls-key`）
 *   ② 环境变量 `DIY_HUB_TLS_CERT` / `DIY_HUB_TLS_KEY`
 * 都没有 → 抛 `tls/requires-trusted-cert`（消息里说清楚「需要受信任的 HTTPS」）。
 */
export function resolveTlsMaterial(sources: TlsSources = {}): TlsMaterial {
    const env = sources.env ?? process.env;
    const certPath = sources.certPath ?? env.DIY_HUB_TLS_CERT;
    const keyPath = sources.keyPath ?? env.DIY_HUB_TLS_KEY;

    if (!certPath || !keyPath) {
        throw new HubError(
            'tls/requires-trusted-cert',
            'Hub 需要受信任的 HTTPS 证书（如 tailscale cert）；请用 --tls-cert/--tls-key 指定，或设置 DIY_HUB_TLS_CERT / DIY_HUB_TLS_KEY',
        );
    }
    for (const path of [certPath, keyPath]) {
        if (!existsSync(path)) {
            throw new HubError('tls/requires-trusted-cert', `证书文件不存在：${path}`, path);
        }
    }
    return { cert: readFileSync(certPath, 'utf-8'), key: readFileSync(keyPath, 'utf-8') };
}

/**
 * 本机 bind 的地址是否**本身就在可信网络里**（不需要应用层 TLS）。
 *
 * 判据不是「谁连上来了」（那要看 socket 对端），而是「我把门开在哪个网卡上」——
 * 门只开在可信网卡上，外面就进不来，这比运行时的开关更难出错。
 *
 *   · loopback  → 内核只把本机进程的连接递进来，不存在中间人
 *   · tailscale → WireGuard 已经端到端加密 + 节点身份由 tailnet 认证，再套 TLS 是重复劳动
 *
 * ⚠️ `0.0.0.0` / `::` / 局域网地址一律**不算**：那会把服务暴露给不可信的网络。
 */
export function isTrustedBindHost(host: string | undefined): boolean {
    if (host === undefined || host === '') return false;
    const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h === '127.0.0.1') return true;
    if (/^127\./.test(h)) return true; // 整个 127.0.0.0/8 都是 loopback

    // tailscale IPv4：100.64.0.0/10（CGNAT 段，tailscale 专用）
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4 !== null) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 100 && b >= 64 && b <= 127;
    }
    // tailscale IPv6 ULA：fd7a:115c:a1e0::/48
    if (h.startsWith('fd7a:115c:a1e0:')) return true;
    return false;
}

/**
 * 服务端启动前的守卫。
 *
 * 判据（2026-11-05 用户裁）：**信任来自「门开在哪」，不是「开了个放行参数」**。
 * 所以这里看的是 bind host，而不是一个 `ALLOW_INSECURE` 布尔 ——
 * 后者只要有人手一抖设成 true，就可能把服务开在 0.0.0.0 上还自认为安全。
 */
export function assertTransportSecurity(
    tls: TlsMaterial | null | undefined,
    bindHost: string | undefined,
): void {
    if (tls) return;
    if (isTrustedBindHost(bindHost)) return;
    throw new HubError(
        'tls/requires-trusted-cert',
        `拒绝在 ${bindHost ?? '(未指定地址)'} 上以明文 HTTP 启动 Hub：` +
            '需要受信任的 HTTPS 证书，或者只绑 loopback / tailscale 地址（判据 8，不静默降级）',
    );
}

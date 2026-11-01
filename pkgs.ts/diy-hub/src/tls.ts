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

/** 服务端启动前的守卫：没有证书又没显式允许明文（只给单测）→ 直接拒绝 */
export function assertTransportSecurity(
    tls: TlsMaterial | null | undefined,
    allowInsecureHttp: boolean | undefined,
): void {
    if (tls) return;
    if (allowInsecureHttp) return;
    throw new HubError(
        'tls/requires-trusted-cert',
        '拒绝以明文 HTTP 启动 Hub：需要受信任的 HTTPS（判据 8，不静默降级）',
    );
}

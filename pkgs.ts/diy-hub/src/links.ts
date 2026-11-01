// 邀请地址与发现载荷。
//
// 核心决策（协议备忘 §二）：**地址即身份**。邀请就是一个真实 URL：
//
//   https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123
//
// 人比对的 host（`c-mac.gute-fish.ts.net`），所以**不许包成 `diy://pair?endpoint=...`**（判据 6）：
// 包装后要解码才能看懂，人就没法比对；不会比对的检查等于没检查。
//
// 判据 2：链接不含 code。判据 8：mDNS 条目不能直接配对（自签证书 + 同网段可伪造同名）。

import { HubError } from './errors.js';
import type { InvitePayload } from './types.js';

/** 把 Hub 基址归一成 `https://host/hub`（允许用户只给 host） */
export function normalizeHubEndpoint(input: string): string {
    let text = input.trim();
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    const url = new URL(text);
    let path = url.pathname.replace(/\/+$/, '');
    // 接受完整邀请地址（`/hub/pair`）—— 取基址时把 `/pair` 剥掉
    if (path.endsWith('/hub/pair')) path = path.slice(0, -'/pair'.length);
    if (!path.endsWith('/hub')) path = path ? `${path}/hub` : '/hub';
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

/** 邀请 URL（二维码内容就是它，**不含 code**） */
export function buildInviteUrl(input: { endpoint: string; inviteId: string }): string {
    const base = normalizeHubEndpoint(input.endpoint);
    return `${base}/pair?inv=${encodeURIComponent(input.inviteId)}`;
}

/** 解析扫码 / 粘贴进来的地址：只认 `.../hub/pair?inv=...`（也接受带末尾斜杠的变体） */
export function parseInviteUrl(input: string): InvitePayload {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new HubError('hub/bad-input', '不是合法的邀请地址（应形如 https://host/hub/pair?inv=...）', input);
    }
    const inviteId = url.searchParams.get('inv');
    if (!inviteId) {
        throw new HubError('hub/bad-input', '邀请地址缺少 inv 参数', input);
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith('/hub/pair')) {
        throw new HubError('hub/bad-input', '邀请地址应以 /hub/pair 结尾', input);
    }
    return { endpoint: normalizeHubEndpoint(input), inviteId };
}

export function invitePayload(input: { endpoint: string; inviteId: string }): InvitePayload {
    return { endpoint: normalizeHubEndpoint(input.endpoint), inviteId: input.inviteId };
}

/** 给人看的地址：只显示 host（`c-mac.gute-fish.ts.net`）—— 人要比对的就是这一段 */
export function displayAddress(endpoint: string): string {
    return new URL(normalizeHubEndpoint(endpoint)).host;
}

export function isMdnsAddress(endpoint: string): boolean {
    try {
        return /\.local$/i.test(new URL(normalizeHubEndpoint(endpoint)).hostname);
    } catch {
        return false;
    }
}

export interface PairingAddressPolicy {
    /** **只给单测 / 内网自建**：显式允许非 tailscale / 明文地址 */
    allowInsecure?: boolean;
}

/**
 * 配对前的地址守卫（判据 8 / 9）：
 *   · mDNS（`.local`）一律拒绝 → 「请使用 tailscale 地址」
 *   · 非 https / 非 `*.ts.net` 一律拒绝（v1 只接受 tailscale 证书）
 * 除非显式 `allowInsecure`（单测 / lab），绝不静默降级。
 */
export function assertPairableAddress(endpoint: string, policy: PairingAddressPolicy = {}): void {
    if (policy.allowInsecure) return;
    const url = new URL(normalizeHubEndpoint(endpoint));
    if (/\.local$/i.test(url.hostname)) {
        throw new HubError('pair/needs-tailscale', `不能通过 mDNS 地址配对（${url.hostname}）：请使用 tailscale 地址`);
    }
    if (url.protocol !== 'https:' || !/\.ts\.net$/i.test(url.hostname)) {
        throw new HubError(
            'pair/needs-tailscale',
            `v1 只接受 tailscale 地址配对（需要受信任的 HTTPS 证书）：${url.host}`,
        );
    }
}

/**
 * mDNS TXT 记录：只放「能列出这台设备」的字段。
 *
 * ⚠️ 发现 ≠ 配对：mDNS 不做身份（判据 8），条目只用于「局域网里有哪些 hub」的展示。
 */
export function buildDiscoveryTxt(input: {
    nodeId: string;
    displayName: string;
    variant: string;
    domainId?: string;
}): Record<string, string> {
    return {
        id: input.nodeId,
        name: input.displayName,
        variant: input.variant,
        domainId: input.domainId ?? 'default',
    };
}

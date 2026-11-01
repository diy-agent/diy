// Hub 身份生命周期：`hub.json` 只放公钥，私钥只进钥匙串。
//
// 判据 13：`grep -c privateKey hub.json` = 0（文件里只有 publicKey）。
// 重复 `init` 不换密钥：换了密钥所有已配对卫星的 pinning 全失效（等于全部撤销）。

import { localISOString } from '@diy-agent/time';
import { HubError } from './errors.js';
import { generateKeyPair, type KeyPair } from './key.js';
import type { SecretStore } from './secret.js';
import { hubDir, HUB_IDENTITY_FILE, readHubIdentity, writeHubIdentity } from './store-fs.js';
import { DEFAULT_DOMAIN_ID, HUB_PROTOCOL_VERSION, type HubIdentity } from './types.js';

/** 钥匙串 account：Hub 私钥 */
export const PRIVATE_KEY_ACCOUNT = 'hub-private-key';

export interface InitHubOptions {
    /** `$DIY_HOME` */
    home: string;
    secrets: SecretStore;
    hubNodeId: string;
    domainId?: string;
    /** 对外真实地址（`https://c-mac.gute-fish.ts.net/hub`），进 hub.json 供邀请 URL 使用 */
    endpoint?: string;
    now?: () => Date;
    keyPair?: KeyPair;
}

export async function initHubIdentity(opts: InitHubOptions): Promise<HubIdentity> {
    const file = hubIdentityFile(opts.home);
    const existing = readHubIdentity(file);
    if (existing) {
        // 已有身份：确保私钥还在钥匙串（用户可能清过钥匙串——这比静默换密钥安全）
        if (!(await opts.secrets.get(PRIVATE_KEY_ACCOUNT))) {
            throw new HubError(
                'keychain/unavailable',
                'hub.json 存在但钥匙串里找不到 Hub 私钥：无法恢复，请先备份 / 手动清理 hub.json 后重新 init（会作废所有已配对卫星）',
            );
        }
        // 地址是可改配置（不是身份）：允许 `init --endpoint` 修正，不动密钥
        if (opts.endpoint && existing.endpoint !== opts.endpoint) {
            const updated: HubIdentity = { ...existing, endpoint: opts.endpoint };
            writeHubIdentity(file, updated);
            return updated;
        }
        return existing;
    }

    const pair = opts.keyPair ?? generateKeyPair();
    await opts.secrets.set(PRIVATE_KEY_ACCOUNT, pair.privateKey);
    const identity: HubIdentity = {
        protocolVersion: HUB_PROTOCOL_VERSION,
        domainId: opts.domainId ?? DEFAULT_DOMAIN_ID,
        hubNodeId: opts.hubNodeId,
        publicKey: pair.publicKey,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        createdAt: localISOString(opts.now?.() ?? new Date()),
    };
    writeHubIdentity(file, identity);
    return identity;
}

export function hubIdentityFile(home: string): string {
    return `${hubDir(home)}/${HUB_IDENTITY_FILE}`;
}

export async function loadHubIdentity(home: string): Promise<HubIdentity> {
    const identity = readHubIdentity(hubIdentityFile(home));
    if (!identity) {
        throw new HubError(
            'hub/not-initialized',
            `还没有 Hub 身份：先跑 diy hub init（找不到 ${hubIdentityFile(home)}）`,
        );
    }
    return identity;
}

/** 取私钥（HMAC 密钥 + 未来签名都用它）。**只从钥匙串取**。 */
export async function loadHubPrivateKey(secrets: SecretStore): Promise<string> {
    const key = await secrets.get(PRIVATE_KEY_ACCOUNT);
    if (!key) {
        throw new HubError('keychain/unavailable', '钥匙串里没有 Hub 私钥：先跑 diy hub init');
    }
    return key;
}

export async function hasHubIdentity(home: string): Promise<boolean> {
    return readHubIdentity(hubIdentityFile(home)) !== null;
}

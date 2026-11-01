// 系统钥匙串实现（macOS `security` CLI）。
//
// 为什么是 `security` 而不是 Electron safeStorage：CLI 先行 —— `diy hub ...` 必须能在
// 没有 Electron 的进程里工作（包也不该反向依赖 app）。Electron 侧将来可以注入自己的
// `SecretStore`，接口不变。
//
// 不可用时返回 `UnavailableSecretStore`：任何调用都**明确报错**，绝不静默落回 JSON。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UnavailableSecretStore, type SecretStore } from './secret.js';

const exec = promisify(execFile);

export const KEYCHAIN_SERVICE = 'diy-hub';

export interface KeychainOptions {
    service?: string;
    platform?: NodeJS.Platform;
}

export function createSystemSecretStore(opts: KeychainOptions = {}): SecretStore {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'darwin') {
        return new UnavailableSecretStore(`v1 只实现了 macOS 钥匙串（当前平台 ${platform}）`);
    }
    const service = opts.service ?? KEYCHAIN_SERVICE;
    return new MacKeychainStore(service);
}

class MacKeychainStore implements SecretStore {
    constructor(private readonly service: string) {}

    async get(account: string): Promise<string | null> {
        try {
            const { stdout } = await exec(
                'security',
                ['find-generic-password', '-s', this.service, '-a', account, '-w'],
                {
                    encoding: 'utf-8',
                },
            );
            // `-w` 输出一行密码 + 换行
            return stdout.replace(/\n$/, '');
        } catch (e) {
            if (isNotFound(e)) return null;
            throw e;
        }
    }

    async set(account: string, secret: string): Promise<void> {
        await exec('security', ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', secret], {
            encoding: 'utf-8',
        });
    }

    async delete(account: string): Promise<void> {
        try {
            await exec('security', ['delete-generic-password', '-s', this.service, '-a', account], {
                encoding: 'utf-8',
            });
        } catch (e) {
            if (!isNotFound(e)) throw e;
        }
    }
}

function isNotFound(e: unknown): boolean {
    const err = e as { code?: number; stderr?: string; message?: string };
    // security 找不到条目时退出码 44（errSecItemNotFound）
    return err.code === 44 || /could not be found|The specified item/i.test(err.stderr ?? err.message ?? '');
}

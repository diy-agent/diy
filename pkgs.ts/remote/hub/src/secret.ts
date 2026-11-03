// 秘密存储接口（钥匙串）。
//
// 硬约束（判据 11–13）：**Token 与 Hub 私钥都不许进普通 JSON 文件**。
// 本接口是唯一入口：内存实现给单测用，系统钥匙串实现在 `keychain.ts`。
//
// 为什么接口放在这里而不是直接调 `security`：测试要能在无系统权限的环境跑；
// 调用方（CLI / app）注入哪个实现，由入口层决定。

import { HubError } from './errors.js';

export interface SecretStore {
    get(account: string): Promise<string | null>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}

/** 内存实现（**只给测试 / 一次性进程**；进程退出即丢） */
export class MemorySecretStore implements SecretStore {
    private readonly map = new Map<string, string>();

    constructor(initial?: Record<string, string>) {
        for (const [k, v] of Object.entries(initial ?? {})) this.map.set(k, v);
    }

    async get(account: string): Promise<string | null> {
        return this.map.get(account) ?? null;
    }

    async set(account: string, secret: string): Promise<void> {
        this.map.set(account, secret);
    }

    async delete(account: string): Promise<void> {
        this.map.delete(account);
    }
}

/** 钥匙串不可用时的兜底：**明确报错**，绝不静默落回普通文件 */
export class UnavailableSecretStore implements SecretStore {
    constructor(private readonly reason: string) {}

    async get(): Promise<string | null> {
        throw new HubError('keychain/unavailable', `系统钥匙串不可用：${this.reason}`);
    }

    async set(): Promise<void> {
        throw new HubError('keychain/unavailable', `系统钥匙串不可用：${this.reason}`);
    }

    async delete(): Promise<void> {
        throw new HubError('keychain/unavailable', `系统钥匙串不可用：${this.reason}`);
    }
}

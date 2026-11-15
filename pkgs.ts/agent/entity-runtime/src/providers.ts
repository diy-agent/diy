// providers.ts —— 模型接入（照 diy 的三段式 key；key 从 env 或 ~/.diy/model.yaml 读）

import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

// 本机网络：IPv6 自动选择会挂（fetch/undici 连接超时），强制 IPv4
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

export interface ParsedModelKey {
    account: string;
    provider: string;
    model: string;
}

const PROVIDER_API: Record<string, string> = {
    'opencode-go': 'https://opencode.ai/inference/go/openai/v1',
    deepseek: 'https://api.deepseek.com',
};

const PROVIDER_ENV: Record<string, string> = {
    'opencode-go': 'OPENCODE_GO_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
};

export function parseModelKey(value: string): ParsedModelKey {
    const at = value.indexOf('@');
    const slash = value.indexOf('/', at + 1);
    if (at < 0 || slash < 0) return { account: 'chen56', provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
    return { account: value.slice(0, at), provider: value.slice(at + 1, slash), model: value.slice(slash + 1) };
}

/** 从 ~/.diy/model.yaml 里取某 provider 下指定账户的 key（极简解析） */
function keyFromDiyConfig(provider: string, account: string): string | undefined {
    try {
        const lines = readFileSync(join(homedir(), '.diy', 'model.yaml'), 'utf8').split('\n');
        const start = lines.findIndex((line) => line.trim() === `${provider}:`);
        if (start < 0) return undefined;
        let current = '';
        for (const line of lines.slice(start + 1)) {
            if (/^ {2}[a-zA-Z0-9_.-]+:\s*$/.test(line)) break;
            const name = /^\s*name:\s*(\S+)/.exec(line);
            if (name?.[1] !== undefined) current = name[1];
            const value = /^\s*value:\s*(\S+)/.exec(line);
            if (value?.[1] !== undefined && current === account) return value[1];
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export function modelOf(modelKey: string): LanguageModel {
    const key = parseModelKey(modelKey);
    const api = PROVIDER_API[key.provider] ?? PROVIDER_API['opencode-go']!;
    const envName = PROVIDER_ENV[key.provider];
    const apiKey =
        (envName === undefined ? undefined : process.env[envName]) ?? keyFromDiyConfig(key.provider, key.account);
    if (apiKey === undefined) throw new Error(`缺少 ${key.provider}/${key.account} 的 key`);
    const provider = createOpenAICompatible({
        name: key.provider,
        baseURL: api,
        apiKey,
        headers: key.provider === 'opencode-go' ? { 'x-opencode-session': `diy2-${Date.now()}` } : {},
    });
    return provider(key.model) as unknown as LanguageModel;
}

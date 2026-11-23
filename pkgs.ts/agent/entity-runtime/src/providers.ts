// providers.ts —— 模型接入（照 diy 的三段式 key；key 从 env 或**本实例数据根**的 model.yaml 读）

import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
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

/** 对话场景的输出上限缺省（对齐老路径 `local-agent.ts` 的 16384 场景缺省） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** 各家 `max_tokens` 的硬上限：发超了直接被 400，所以按 provider 收窄 */
const MAX_OUTPUT_BY_PROVIDER: Record<string, number> = {
    // DeepSeek 官方：deepseek-chat 的 max_tokens 上限 8192
    deepseek: 8_192,
};

/**
 * 本轮要发出去的 `max_tokens`。
 *
 * **为什么必须显式发**：不发就是吃服务端缺省（远小于上下文能吃的量）。模型写到一半被砍断时，
 * 流里只表现为 `finishReason: "length"` —— 不设值又不在收尾处读 finishReason，
 * 症状就是「执行一半就停下，UI 却显示完成」（`##429` 在老路径修过一次，迁移时丢了）。
 *
 * 优先级：env `DIY_LOCAL_MAX_OUTPUT_TOKENS` > 调用方传入 > provider 硬上限 > 场景缺省。
 */
export function maxOutputTokensOf(modelKey: string, explicit?: number): number {
    const fromEnv = Number.parseInt(process.env.DIY_LOCAL_MAX_OUTPUT_TOKENS ?? '', 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
    if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
    const key = parseModelKey(modelKey);
    return MAX_OUTPUT_BY_PROVIDER[key.provider] ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * model.yaml 的路径（**只认数据根**，此刻意不回落生产配置）：
 *   1. `DIY_MODEL_CONFIG` —— 显式文件；
 *   2. `DIY_HOME/model.yaml` —— 本实例数据根下的配置（diy-app / diy2 同一口径）；
 *   3. 都没有 → `undefined`：不读任何文件（key 只能从 env 拿）。
 *
 * 为什么删掉「回落 `~/.diy/model.yaml`」这一档（2026-11-23）：测试实例只换数据根、配置
 * 却仍读生产真账号，等于**假隔离** —— lab 里的实验会用生产 key，而任何人以为自己在沙箱里。
 * 现在测试实例完全依赖自己的数据根：缺配置就报「缺 key」，由 `scripts/seed-run-home.sh`
 * 显式把 `~/.diy` 的配置**填充**进去（准备动作，不是运行时查找）。
 */
export function modelConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const explicit = env['DIY_MODEL_CONFIG']?.trim();
    if (explicit !== undefined && explicit !== '') return explicit;
    const home = env['DIY_HOME']?.trim();
    if (home !== undefined && home !== '') return join(home, 'model.yaml');
    return undefined;
}

/** 从 model.yaml 里取某 provider 下指定账户的 key（极简解析） */
function keyFromDiyConfig(provider: string, account: string): string | undefined {
    const path = modelConfigPath();
    if (path === undefined) return undefined;
    try {
        const lines = readFileSync(path, 'utf8').split('\n');
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
    if (apiKey === undefined) {
        const hint = modelConfigPath();
        throw new Error(
            `缺少 ${key.provider}/${key.account} 的 key` +
                (hint === undefined
                    ? '（未设置 DIY_HOME / DIY_MODEL_CONFIG，未读任何配置）'
                    : `（${hint} 里没有；测试实例可跑 scripts/seed-run-home.sh 填充）`),
        );
    }
    const provider = createOpenAICompatible({
        name: key.provider,
        baseURL: api,
        apiKey,
        headers: key.provider === 'opencode-go' ? { 'x-opencode-session': `diy2-${Date.now()}` } : {},
    });
    return provider(key.model) as unknown as LanguageModel;
}

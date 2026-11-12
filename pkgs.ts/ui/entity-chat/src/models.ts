// models.ts —— 模型目录（形状照 diy 的 model.yaml / provider 配置）
//
//   providers[]        一个 provider = 端点 + 账户列表 + 模型目录
//   accounts[]         账户名（diy 的三段式 key 的第一段）
//   models{}           id → 元数据（name / 上下文 / 价目）
//   modelKey           `account@provider/model`（diy 现用格式）
//
// 默认模型：chen56@opencode-go/deepseek-v4.1-flash（与当前 diy 一致）。

export interface ModelCost {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

export interface ModelInfo {
    id: string;
    name: string;
    contextWindow?: number;
    cost?: ModelCost;
}

export interface ProviderAccount {
    type: 'apiKey';
    name: string;
}

export interface Provider {
    id: string;
    name: string;
    /** 上游基址（不含 /chat/completions） */
    api: string;
    /** ai-sdk 包名（diy 的 provider-defaults 用同一字段） */
    npm: string;
    accounts: ProviderAccount[];
    models: Record<string, ModelInfo>;
}

export const PROVIDERS: Provider[] = [
    {
        id: 'opencode-go',
        name: 'OpenCode Go',
        api: 'https://opencode.ai/inference/go/openai/v1',
        npm: '@ai-sdk/openai-compatible',
        accounts: [{ type: 'apiKey', name: 'chen56' }, { type: 'apiKey', name: 'aug' }, { type: 'apiKey', name: 'fatfatjing' }],
        models: {
            'deepseek-v4.1-flash': {
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                contextWindow: 131072,
                cost: { input: 0.14, output: 0.28, cacheRead: 0.014 },
            },
            'deepseek-v4-pro': {
                id: 'deepseek-v4-pro',
                name: 'DeepSeek V4 Pro',
                contextWindow: 131072,
                cost: { input: 0.6, output: 2.4, cacheRead: 0.06 },
            },
            'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262144, cost: { input: 0.3, output: 1.2 } },
        },
    },
    {
        id: 'deepseek',
        name: 'DeepSeek（直连）',
        api: 'https://api.deepseek.com',
        npm: '@ai-sdk/openai-compatible',
        accounts: [{ type: 'apiKey', name: 'chen56' }],
        models: {
            'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 65536, cost: { input: 0.27, output: 1.1 } },
            'deepseek-reasoner': { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 65536, cost: { input: 0.55, output: 2.19 } },
        },
    },
];

/** 三段式：`account@provider/model` */
export interface ModelKey {
    provider: string;
    account: string;
    model: string;
}

export const DEFAULT_MODEL_KEY = 'chen56@opencode-go/deepseek-v4.1-flash';

export function formatModelKey(key: ModelKey): string {
    return `${key.account}@${key.provider}/${key.model}`;
}

export function parseModelKey(value: string): ModelKey {
    const at = value.indexOf('@');
    const slash = value.indexOf('/', at + 1);
    if (at < 0 || slash < 0) return { provider: PROVIDERS[0]!.id, account: PROVIDERS[0]!.accounts[0]!.name, model: Object.keys(PROVIDERS[0]!.models)[0]! };
    return { account: value.slice(0, at), provider: value.slice(at + 1, slash), model: value.slice(slash + 1) };
}

export function providerOf(id: string): Provider {
    return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]!;
}

export function modelInfoOf(key: ModelKey): ModelInfo | undefined {
    return providerOf(key.provider).models[key.model];
}

export function modelLabel(value: string): string {
    const key = parseModelKey(value);
    const info = modelInfoOf(key);
    return `${info?.name ?? key.model} · ${key.account}@${key.provider}`;
}

export function contextWindowLabel(value: string): string {
    const size = modelInfoOf(parseModelKey(value))?.contextWindow;
    if (size === undefined) return '窗口未知';
    return `${Math.round(size / 1024)}k 上下文`;
}

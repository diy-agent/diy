// provider-defaults.ts — 已知 provider 的默认值表 + 配置解析（纯数据 + 纯函数，零 IO）。
//
// 边界：本文件只回答「这个名字对应的 endpoint / ai-sdk 包 / 附带 header 是什么」。
// 它不读 model.yaml、不读环境变量、不探测网络、不判白名单 —— **表里有没有就是白名单**。
//
// 数据来源（每条注明，一律抄已验证的实现，不猜）：
//   pi  = ~/git-ref/pi/packages/ai/src/providers/<name>.ts（`baseUrl` + `api: openAICompletionsApi()`）
//   dsh = ~/git-ref/deepseek-harness/packages/llm/llm-pi-ai/src/provider-data.generated.ts
//         （defaultBaseURL，由 pi-ai catalog 生成，与 pi 的 baseUrl 一致）
//   oc  = ~/git-ref/opencode/services/www/src/docs/content/console/api/inference.mdx
//         + ~/git-ref/pi/packages/ai/scripts/generate-models.ts:2235-2271（basePath → `${basePath}/v1`）

// ##491：opencode 的会话 header（含 `$SESSION` 占位符）真源在策略文件里，这里只引用、不重抄字面量。
import { OPENCODE_HEADERS } from './strategies/opencode.js';
import type { ProviderConfig } from './types.js';

/** 一个 provider 的默认值：用哪个 ai-sdk 包（决定协议面）、默认 endpoint、附带 header */
export interface ProviderDefaults {
    /** 用哪个 ai-sdk 包（决定协议面） */
    readonly npm: '@ai-sdk/openai-compatible' | '@ai-sdk/openai';
    /** 默认 endpoint（不含 `/chat/completions`；与 `ProviderConfig.baseURL` 同义） */
    readonly api?: string;
    /**
     * 该 provider 要求的额外 header。
     * 值是字面量，或含 `$SESSION` 占位符（真源见 `strategies/opencode.ts`）—— 后者由
     * `createOpenAiCompatible` 在**每次调用**时替换成 `ChatOptions.sessionId`；
     * 会话 id 缺席则整条 header 不传（不是空串）。
     */
    readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 表：键 = provider 名（调用方自己起的路由名，与 `ProviderConfig.name` 无关）。
 *
 * 只放**已确认可用**的条目：全部是 OpenAI 兼容的 chat-completions 协议面。
 * 用别的协议（openai-responses / anthropic-messages / google-generative-ai …）的 provider 故意不在表里 ——
 * 本包只产 `@ai-sdk/openai-compatible`，放进来也消费不了。
 */
export const PROVIDER_DEFAULTS: Readonly<Record<string, ProviderDefaults>> = {
    // ── OpenCode：openai 兼容面 + 会话 header（pi providers/opencode-headers.ts）──
    // `/go/openai/v1` 是 ##463 实测 200 的端点；`/inference/v1` 来自 pi generate-models.ts:2252-2269
    // header 的**真源**是 `strategies/opencode.ts`（##491：provider 私有约定归策略）
    'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://opencode.ai/inference/go/openai/v1',
        headers: OPENCODE_HEADERS,
    },
    opencode: {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://opencode.ai/inference/v1',
        headers: OPENCODE_HEADERS,
    },

    // ── 直连上游：pi providers/<name>.ts 的 baseUrl（dsh 的 defaultBaseURL 同值）──
    deepseek: { npm: '@ai-sdk/openai-compatible', api: 'https://api.deepseek.com' },
    groq: { npm: '@ai-sdk/openai-compatible', api: 'https://api.groq.com/openai/v1' },
    moonshotai: { npm: '@ai-sdk/openai-compatible', api: 'https://api.moonshot.ai/v1' },
    'moonshotai-cn': { npm: '@ai-sdk/openai-compatible', api: 'https://api.moonshot.cn/v1' },
    cerebras: { npm: '@ai-sdk/openai-compatible', api: 'https://api.cerebras.ai/v1' },
    zai: { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/coding/paas/v4' },
    'zai-coding-cn': { npm: '@ai-sdk/openai-compatible', api: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    together: { npm: '@ai-sdk/openai-compatible', api: 'https://api.together.ai/v1' },
    nvidia: { npm: '@ai-sdk/openai-compatible', api: 'https://integrate.api.nvidia.com/v1' },
    openrouter: { npm: '@ai-sdk/openai-compatible', api: 'https://openrouter.ai/api/v1' },
    xiaomi: { npm: '@ai-sdk/openai-compatible', api: 'https://api.xiaomimimo.com/v1' },
    kimi: { npm: '@ai-sdk/openai-compatible', api: 'https://api.kimi.com/coding/v1' },
    'ant-ling': { npm: '@ai-sdk/openai-compatible', api: 'https://api.ant-ling.com/v1' },
    baseten: { npm: '@ai-sdk/openai-compatible', api: 'https://inference.baseten.co/v1' },
    fireworks: { npm: '@ai-sdk/openai-compatible', api: 'https://api.fireworks.ai/inference' },
    huggingface: { npm: '@ai-sdk/openai-compatible', api: 'https://router.huggingface.co/v1' },
};

/** `resolveProviderConfig` 的入参：调用方给「谁 + 密钥 + 模型」，其余从表里补 */
export interface ResolveProviderOptions {
    /** 表里的键（不认识的键当场报错：不在表里就是不可用） */
    readonly provider: string;
    readonly apiKey: string;
    /** 缺省模型 id（逐次可用 `chat(messages, { model })` 覆盖） */
    readonly model: string;
    /** 覆盖表里的 `api`（自建网关 / 代理） */
    readonly baseURL?: string;
    /** 追加 / 覆盖表里的 header（`$SESSION` 占位符照旧生效） */
    readonly headers?: Readonly<Record<string, string>>;
    /** 注入的 fetch（测试用假 HTTP；缺省 = 全局 fetch） */
    readonly fetch?: typeof globalThis.fetch;
}

/**
 * 表 + 调用方输入 → `ProviderConfig`（可直接喂 `createOpenAiCompatible`）。
 *
 * 不做白名单校验逻辑：表里没有就是没有，报错时把可选项列出来。
 * `$SESSION` 不在这里替换 —— 会话 id 每次调用才知道，由 provider 在 chat 时填。
 */
export function resolveProviderConfig(options: ResolveProviderOptions): ProviderConfig {
    const defaults = PROVIDER_DEFAULTS[options.provider];
    if (defaults === undefined) {
        const known = Object.keys(PROVIDER_DEFAULTS).join(', ');
        throw new TypeError(`resolveProviderConfig: 未知 provider "${options.provider}"（可用：${known}）`);
    }
    if (defaults.npm !== '@ai-sdk/openai-compatible') {
        // 本包只有一种实现；其余协议面等支持了再加分支（宁可响亮失败，不静默降级）
        throw new TypeError(
            `resolveProviderConfig: provider "${options.provider}" 走 ${defaults.npm}，本包只支持 @ai-sdk/openai-compatible`,
        );
    }
    const baseURL = options.baseURL ?? defaults.api;
    if (baseURL === undefined || baseURL.length === 0) {
        throw new TypeError(`resolveProviderConfig: provider "${options.provider}" 没有默认 endpoint，请传 baseURL`);
    }
    const headers = { ...defaults.headers, ...options.headers };
    return {
        baseURL,
        apiKey: options.apiKey,
        model: options.model,
        name: options.provider,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
}

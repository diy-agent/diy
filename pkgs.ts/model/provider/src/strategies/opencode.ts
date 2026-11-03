// strategies/opencode.ts — opencode 网关（zen / go）的私有约定（##491，从 diy-app 搬来）
//
// 两件都是网关自己的规矩，直连上游没有：
//   ① 会话路由 header `x-opencode-session`（缺了直接 400 MissingSessionID）
//   ② 缓存保留期 `prompt_cache_retention=24h`（缺了跨轮整段重算）
//
// ── ② 的实测（2026-10-31，opencode-go / deepseek-v4.1-flash，120k prompt，同 session）──
//   · 不带参数：   冷却 6m40s 后 cached_tokens = 0          （整段丢）
//   · retention 24h：同样冷却后 cached_tokens = 119,936    （整段命中）
//   两条只差一个请求字段，其它全同 ⇒ 差的是网关的保留期，不是我们的前缀。
//
// ── 为什么只对 opencode 端点发 ──
//   `prompt_cache_retention` 是网关（zen / go）自己的字段；直连上游（deepseek / moonshot …
//   的 OpenAI 兼容面）没验证过会不会 400。**未验证的字段不发** —— 省下的钱不值得换一次 400。
//
// 纯函数，禁止 import node:*（renderer 会打进包）。

import type { ProviderStrategy, StrategyContext } from './types.js';

/** 网关要求的会话路由 header（缺了直接 400 `MissingSessionID`） */
export const SESSION_HEADER = 'x-opencode-session';

/**
 * 会话标识占位符：`ProviderDefaults.headers` 的值里出现它，就由 `createOpenAiCompatible`
 * 在**每次调用**时替换成 `ChatOptions.sessionId`（会话 id 缺席则整条 header 不传）。
 *
 * 机制本身是通用的（任何 provider 的表头都能用），但目前只有 opencode 的两条默认值用到它 ——
 * 故与 opencode 策略同处一份文件（##491 用户裁决：别散在 provider-defaults 里）。
 */
export const SESSION_PLACEHOLDER = '$SESSION';

/** opencode 端点要求的默认 header（`PROVIDER_DEFAULTS` 直接引用，别在那边再抄一遍字面量） */
export const OPENCODE_HEADERS: Readonly<Record<string, string>> = {
    [SESSION_HEADER]: SESSION_PLACEHOLDER,
};

/** 要补的保留期（网关文档里的上限；与 ttl:"1h" 无关，这是 24h retention 档） */
export const PROMPT_CACHE_RETENTION = '24h';

/**
 * 这个 endpoint 是不是 opencode 网关（`opencode.ai`，含 zen `/inference/v1` 与 go `/inference/go/...`）。
 *
 * 用 host 判而不是 provider 名：provider 名是调用方自己起的路由名（model.yaml 里可随意改名），
 * host 才是「请求真的发去哪」。解析不了 URL ⇒ false（当作不认识的端点，不补字段）。
 */
export function isOpencodeEndpoint(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).host === 'opencode.ai';
    } catch {
        return false;
    }
}

/**
 * 给请求体补 `prompt_cache_retention`（不改原对象；已有值就不覆盖 —— 逐次覆盖是调用方的权利）。
 */
export function withPromptCacheRetention(
    body: Record<string, unknown>,
    _ctx: StrategyContext = {},
): Record<string, unknown> {
    if (body['prompt_cache_retention'] !== undefined) return body;
    return { ...body, prompt_cache_retention: PROMPT_CACHE_RETENTION };
}

/**
 * 补会话路由 header（不改原对象）。
 *
 * 没有 `sessionId` 就整体跳过：发个空串只会让网关按 "空会话" 记账（归属全错），不发反而响亮。
 * 调用方明确给了别的值也照我们的写 —— 会话 id 的真源只有应用层那一处 `sessionIdOf(taskUri)`。
 */
export function withSessionHeader(
    headers: Record<string, string>,
    ctx: StrategyContext = {},
): Record<string, string> {
    const sessionId = ctx.sessionId;
    if (sessionId === undefined || sessionId === '') return headers;
    return { ...headers, [SESSION_HEADER]: sessionId };
}

/** opencode 网关策略（zen 与 go 共用：host 相同，约定相同） */
export const opencodeStrategy: ProviderStrategy = {
    name: 'opencode',
    matches: isOpencodeEndpoint,
    transformBody: withPromptCacheRetention,
    transformHeaders: withSessionHeader,
};

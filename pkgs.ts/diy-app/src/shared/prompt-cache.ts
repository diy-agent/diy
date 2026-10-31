// src/shared/prompt-cache.ts
// 🎯 提示词缓存保留期（##486）：opencode 网关的**自动前缀缓存只活约 5 分钟**，
//    跨轮聊天（人打字 / 看结果，间隔常 5~15 分钟）于是每轮整段重算。
//    390k 上下文的会话，一次冷启动 = 全量 394k 输入 ≈ $0.056（##266 实测）。
//
// ── 实测（2026-10-31，opencode-go / deepseek-v4.1-flash，120k prompt，同 session）──
//   · 不带参数：   冷却 6m40s 后 cached_tokens = 0          （整段丢）
//   · retention 24h：同样冷却后 cached_tokens = 119,936    （整段命中）
//   两条只差一个请求字段，其它全同 ⇒ 差的是网关的保留期，不是我们的前缀。
//
// ── 为什么只对 opencode 端点发 ──
//   `prompt_cache_retention` 是网关（zen / go）自己的字段；直连上游（deepseek / moonshot …
//   的 OpenAI 兼容面）没有验证过会不会 400。**未验证的字段不发** —— 省下的钱不值得换一次 400。
//
// 纯函数，禁止 import node:*（renderer 会打进包）。

/** 要补的保留期（网关文档里的上限；与 ttl:"1h" 无关，这是 24h retention 档） */
export const PROMPT_CACHE_RETENTION = "24h";

/**
 * 这个 endpoint 是不是 opencode 网关（`opencode.ai`，含 zen `/inference/v1` 与 go `/inference/go/...`）。
 *
 * 用 host 判而不是 provider 名：provider 名是调用方自己起的路由名（model.yaml 里可随意改名），
 * host 才是「请求真的发去哪」。解析不了 URL ⇒ false（当作不认识的端点，不补字段）。
 */
export function isOpencodeEndpoint(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).host === "opencode.ai";
    } catch {
        return false;
    }
}

/**
 * 给请求体补 `prompt_cache_retention`（不改原对象；已有值就不覆盖 —— 逐次覆盖是调用方的权利）。
 *
 * 用法：`createOpenAICompatible({ transformRequestBody: withPromptCacheRetention })`
 * 只在 `isOpencodeEndpoint(baseUrl)` 为真时挂。
 */
export function withPromptCacheRetention(body: Record<string, unknown>): Record<string, unknown> {
    if (body["prompt_cache_retention"] !== undefined) return body;
    return { ...body, prompt_cache_retention: PROMPT_CACHE_RETENTION };
}

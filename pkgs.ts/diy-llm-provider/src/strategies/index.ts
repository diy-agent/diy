// strategies/index.ts — 策略注册表（##491）
//
// 用法（应用层只认这两个函数，永远不认具体 provider）：
//
// ```ts
// import { headersFor, strategyFor } from '@diy-agent/llm-provider/strategies';
//
// const body = strategyFor(baseUrl).transformBody?.(raw, {}) ?? raw;
// const headers = headersFor(baseUrl, { sessionId });   // 该端点要补的头；{} = 不补
// ```
//
// 加新 provider = **新增一个策略文件 + 在 STRATEGIES 里加一行**（顺序即优先级）。

import { opencodeStrategy } from './opencode.js';
import { passthroughStrategy } from './passthrough.js';
import { veniceStrategy } from './venice.js';
import type { ProviderStrategy, StrategyContext } from './types.js';

export type { ProviderStrategy, StrategyContext } from './types.js';
export {
    OPENCODE_HEADERS,
    PROMPT_CACHE_RETENTION,
    SESSION_HEADER,
    SESSION_PLACEHOLDER,
    isOpencodeEndpoint,
    opencodeStrategy,
    withPromptCacheRetention,
    withSessionHeader,
} from './opencode.js';
export { passthroughStrategy } from './passthrough.js';
export { veniceStrategy } from './venice.js';

/**
 * 注册表：**按顺序匹配，第一个命中的生效**；都没命中用 passthrough。
 *
 * 顺序 = 优先级：先放「会加东西的」具体策略，再放占位，最后 passthrough 兜底。
 */
export const STRATEGIES: readonly ProviderStrategy[] = [opencodeStrategy, veniceStrategy, passthroughStrategy];

/**
 * 取该 endpoint 的策略。
 *
 * `registry` 可替换只为测试「加新 provider 只需新增文件 + 注册一行」—— 临时策略塞进去就该被认领。
 */
export function strategyFor(baseUrl: string, registry: readonly ProviderStrategy[] = STRATEGIES): ProviderStrategy {
    for (const strategy of registry) {
        if (strategy.matches(baseUrl)) return strategy;
    }
    return passthroughStrategy;
}

/**
 * 该端点要补的请求头（不改入参；空对象 = 什么都不补）。
 *
 * 调用方拿着这个结果去发请求即可，不必知道是哪个 provider、补的是哪个 header。
 */
export function headersFor(
    baseUrl: string,
    ctx: StrategyContext = {},
    registry: readonly ProviderStrategy[] = STRATEGIES,
): Record<string, string> {
    const strategy = strategyFor(baseUrl, registry);
    return strategy.transformHeaders === undefined ? {} : strategy.transformHeaders({}, ctx);
}

/**
 * 该端点要补的请求体变换（`undefined` = 不补，别挂一个恒等函数 —— 白复制一次对象）。
 *
 * 直接喂给 ai-sdk 的 `transformRequestBody`：`...(...)`
 */
export function bodyTransformFor(
    baseUrl: string,
    ctx: StrategyContext = {},
    registry: readonly ProviderStrategy[] = STRATEGIES,
): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
    const strategy = strategyFor(baseUrl, registry);
    const transform = strategy.transformBody;
    if (transform === undefined) return undefined;
    return (body: Record<string, unknown>) => transform(body, ctx);
}

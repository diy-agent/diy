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
// 目录约定：
//   · providers/<name>/index.ts —— 一个网关一行：按 **host** 认领的私有约定
//    （会话 header / 网关专属请求字段 / tool 结果多段内容）
//   · models/<family>/…          —— 模型族差异：按 **模型身份** 认领（如 deepseek 的
//     reasoning_content 补空串）
//
// 加新 provider = **新增一个目录 + 在 STRATEGIES 里加一行**（顺序即优先级）。

import { opencodeStrategy } from './providers/opencode/index.js';
import { passthroughStrategy } from './providers/passthrough/index.js';
import { veniceStrategy } from './providers/venice/index.js';
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
} from './providers/opencode/index.js';
export { passthroughStrategy } from './providers/passthrough/index.js';
export { veniceStrategy } from './providers/venice/index.js';

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
 * 该端点收不收 tool 结果里的多段内容（文本 + 图片）。
 *
 * 直接喂给 ai-sdk `createOpenAICompatible({ supportsMultiPartToolContent })`；
 * 没实测过的端点 = false（缺省口径），别猜。
 */
export function multiPartToolContentFor(baseUrl: string, registry: readonly ProviderStrategy[] = STRATEGIES): boolean {
    return strategyFor(baseUrl, registry).multiPartToolContent === true;
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

/**
 * 喂给 `@ai-sdk/openai-compatible` 的**非通用设置**（该端点才有的约定）。
 *
 * 存在的理由：`supportsMultiPartToolContent` / `prompt_cache_retention` 这类字段是
 * **某个 provider 的协议差异**，不是应用层的事。调用方只 spread 这一个对象，
 * common code 里不出现任何具体字段名，也不出现按 provider 名写死的 if / switch。
 *
 * 形状照 `createOpenAICompatible` 的入参：缺省的键**不出现**（exactOptionalPropertyTypes）。
 */
export interface OpenAiCompatibleSettings {
    /** 该端点要求的额外 header（已按 ctx 填好 `$SESSION` 那类占位符） */
    readonly headers?: Record<string, string>;
    /** 该端点要补的请求体字段（不改原对象） */
    readonly transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>;
    /** 该端点收 tool 结果里的多段内容（文本 + 图片） */
    readonly supportsMultiPartToolContent?: true;
}

export function openAiCompatibleSettingsFor(
    baseUrl: string,
    ctx: StrategyContext = {},
    registry: readonly ProviderStrategy[] = STRATEGIES,
): OpenAiCompatibleSettings {
    const headers = headersFor(baseUrl, ctx, registry);
    const transformRequestBody = bodyTransformFor(baseUrl, ctx, registry);
    const multiPart = multiPartToolContentFor(baseUrl, registry);
    return {
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(transformRequestBody === undefined ? {} : { transformRequestBody }),
        ...(multiPart ? { supportsMultiPartToolContent: true as const } : {}),
    };
}

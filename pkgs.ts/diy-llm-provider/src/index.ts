// index.ts — @diy/llm-provider 的公开入口。
//
// 一句话：给 OpenAI 兼容上游一个 `LlmPort`（`@diy/session` 的端口），外加一份最小模型目录。
// 不含：人设 / 系统提示 / 工具执行 / 重试 / 会话状态 —— 那些是别的包与调用方的事。
export { createOpenAiCompatible } from './openai.js';
export type { LlmProvider, UsageDelta } from './openai.js';
export { LlmProviderError, classifyError, type LlmProviderErrorCode } from './errors.js';
export { DEFAULT_MODEL_ID, DEFAULT_MODELS, findModel } from './catalog.js';
export type { ModelCost, ModelInfo, ProviderConfig, UsageDetail } from './types.js';

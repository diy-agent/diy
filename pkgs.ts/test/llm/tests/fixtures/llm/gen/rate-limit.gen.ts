// rate-limit.gen.ts — 429 rate_limit_error · 上游模型临时不可用（真实 3 次）—— 短暂退避后可重试
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts rate-limit
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:41:42.833Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const rateLimit: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"deepseek-v4.1-flash","stream":true},"statusCode":429,"responseBody":"{\"error\":{\"message\":\"Upstream model provider is temporarily unavailable. Please try again in a moment.\",\"type\":\"rate_limit_error\"}}","isRetryable":true,"data":{"error":{"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"rate_limit_error"}}}},
];

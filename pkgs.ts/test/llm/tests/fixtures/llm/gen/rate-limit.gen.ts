// rate-limit.gen.ts — 上游 429 限流 —— 下游要退避重试，不是当成永久失败
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts rate-limit
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:28:00.154Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const rateLimit: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"<any>","stream":true},"statusCode":429,"responseHeaders":{"retry-after":"2"},"responseBody":"{\"error\":{\"type\":\"rate_limit_exceeded\",\"message\":\"Too many requests\"}}","isRetryable":true,"data":{"error":{"type":"rate_limit_exceeded","message":"Too many requests"}}}},
];

// endpoint-unavailable.gen.ts — 429 server_error · 上游 endpoint 整体不可用（真实 21 次）—— 下游要退避重试
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts endpoint-unavailable
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:41:41.678Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const endpointUnavailable = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"deepseek-v4.1-flash","stream":true},"statusCode":429,"responseBody":"{\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}","isRetryable":true,"data":{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}}},
] as unknown as LanguageModelV3StreamPart[];

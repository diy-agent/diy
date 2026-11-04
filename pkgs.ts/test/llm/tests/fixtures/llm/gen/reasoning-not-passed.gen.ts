// reasoning-not-passed.gen.ts — 400 invalid_request_error · thinking 模式的 reasoning_content 必须回传（真实 15 次，真 bug）
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts reasoning-not-passed
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:41:42.317Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const reasoningNotPassed: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"deepseek-v4.1-flash","stream":true},"statusCode":400,"responseBody":"{\"error\":{\"param\":null,\"type\":\"invalid_request_error\",\"code\":\"invalid_request_error\",\"message\":\"Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.\"}}","isRetryable":false,"data":{"error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API."}}}},
];

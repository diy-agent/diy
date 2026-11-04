// context-overflow.gen.ts — 上下文溢出 —— 上游报超长，下游触发压缩后再试
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts context-overflow
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:28:00.717Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const contextOverflow: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"<any>","stream":true},"statusCode":400,"responseBody":"{\"error\":{\"type\":\"context_length_exceeded\",\"message\":\"This model's maximum context length is 1050000 tokens\"}}","isRetryable":false,"data":{"error":{"type":"context_length_exceeded","message":"This model's maximum context length is 1050000 tokens"}}}},
];

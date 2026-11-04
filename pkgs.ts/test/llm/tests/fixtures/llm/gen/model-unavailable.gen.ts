// model-unavailable.gen.ts — 上游 404 model_coming_soon —— 下游要停工 + 顶出提示条，不换模型硬试
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts model-unavailable
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:27:59.401Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const modelUnavailable: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"error","error":{"name":"AI_APICallError","url":"https://opencode.ai/inference/go/openai/v1/chat/completions","requestBodyValues":{"model":"<unavailable>","stream":true},"statusCode":404,"responseBody":"{\"error\":{\"type\":\"model_coming_soon\",\"message\":\"model_coming_soon\"}}","isRetryable":false,"data":{"error":{"type":"model_coming_soon","message":"model_coming_soon"}}}},
];

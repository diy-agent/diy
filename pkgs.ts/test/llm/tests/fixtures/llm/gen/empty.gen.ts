// empty.gen.ts — done 但零内容 —— 下游要显示「(空回复)」而不是挂住等
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts empty
// 来源：协议形状合成（真跑不出来） · 2026-11-04T06:28:01.360Z
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const empty: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"chatcmpl-empty","modelId":"<any>","timestamp":"2026-11-04T06:28:01.355Z"},
    {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":0}}},
];

// abort.gen.ts — 流到一半被中断（下游据此进 aborted 分支）
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts abort
// 录制于 2026-11-04T06:27:04.600Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const abort = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"chatcmpl-21398363aba149ca8236ad6a48e29755","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:27:07.000Z"},
    {"type":"reasoning-start","id":"reasoning-0"},
] as unknown as LanguageModelV3StreamPart[];

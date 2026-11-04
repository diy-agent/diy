// tool-ok.gen.ts — 一次工具调用 + 拿到结果后的收尾文本
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts tool-ok
// 录制于 2026-11-04T06:27:02.584Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const toolOk: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"gw-b12ea3780387-127bd2","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:27:05.000Z"},
    {"type":"tool-input-start","id":"call_56e791bc383a4498a0eefc09","toolName":"read"},
    {"type":"tool-input-delta","id":"call_56e791bc383a4498a0eefc09","delta":"{\"path\":\""},
    {"type":"tool-input-delta","id":"call_56e791bc383a4498a0eefc09","delta":"README"},
    {"type":"tool-input-delta","id":"call_56e791bc383a4498a0eefc09","delta":".md"},
    {"type":"tool-input-delta","id":"call_56e791bc383a4498a0eefc09","delta":"\""},
    {"type":"tool-input-delta","id":"call_56e791bc383a4498a0eefc09","delta":"}"},
    {"type":"tool-input-end","id":"call_56e791bc383a4498a0eefc09"},
    {"type":"tool-call","toolCallId":"call_56e791bc383a4498a0eefc09","toolName":"read","input":"{\"path\":\"README.md\"}"},
    {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":323,"noCache":323,"cacheRead":0},"outputTokens":{"total":39,"text":39,"reasoning":0},"raw":{"prompt_tokens":323,"completion_tokens":39,"total_tokens":362,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0},"cost":0,"opencode":{"billing_source":"go","list_cost":0.0001437,"allowance":0.00008622,"tokens":{"input":323,"output":39,"reasoning":0,"cache_read":0,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
];

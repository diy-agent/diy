// tool-error.gen.ts — 工具调用返回错误后模型怎么收尾
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts tool-error
// 录制于 2026-11-04T06:27:26.340Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const toolError: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"chatcmpl-d7dc9671ba0b4f6e83fac916e0fce36b","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:27:27.000Z"},
    {"type":"tool-input-start","id":"call_4a25047854dd49eaa05217ba","toolName":"read"},
    {"type":"tool-input-delta","id":"call_4a25047854dd49eaa05217ba","delta":"{\"path\":\"/n"},
    {"type":"tool-input-delta","id":"call_4a25047854dd49eaa05217ba","delta":"ope/does-not-exist"},
    {"type":"tool-input-delta","id":"call_4a25047854dd49eaa05217ba","delta":".txt\""},
    {"type":"tool-input-delta","id":"call_4a25047854dd49eaa05217ba","delta":"}"},
    {"type":"tool-input-end","id":"call_4a25047854dd49eaa05217ba"},
    {"type":"tool-call","toolCallId":"call_4a25047854dd49eaa05217ba","toolName":"read","input":"{\"path\":\"/nope/does-not-exist.txt\"}"},
    {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":330,"noCache":202,"cacheRead":128},"outputTokens":{"total":46,"text":46,"reasoning":0},"raw":{"prompt_tokens":330,"completion_tokens":46,"total_tokens":376,"prompt_tokens_details":{"cached_tokens":128},"completion_tokens_details":{"reasoning_tokens":0},"cost":0,"opencode":{"billing_source":"go","list_cost":0.00011657,"allowance":0.00006994,"tokens":{"input":202,"output":46,"reasoning":0,"cache_read":128,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
];

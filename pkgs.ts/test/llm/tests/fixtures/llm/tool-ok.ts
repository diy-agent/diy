// toolOk.ts — 一次工具调用 + 拿到结果后的收尾文本
// 自动生成，勿手改。重录：node tools/record-llm.mts tool-ok
// 录制于 2026-11-04T06:22:27.451Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const toolOk: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"3af2f556-b430-4c5a-b942-a2d37712431f","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:22:29.000Z"},
    {"type":"tool-input-start","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","toolName":"read"},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"{\""},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"path"},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"\""},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":": \""},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"README"},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":".md"},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"\""},
    {"type":"tool-input-delta","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","delta":"}"},
    {"type":"tool-input-end","id":"call_00_ET_NHEv4eafq7VsTlOye7TS5061"},
    {"type":"tool-call","toolCallId":"call_00_ET_NHEv4eafq7VsTlOye7TS5061","toolName":"read","input":"{\"path\": \"README.md\"}"},
    {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":328,"noCache":328,"cacheRead":0},"outputTokens":{"total":38,"text":38,"reasoning":0},"raw":{"prompt_tokens":328,"completion_tokens":38,"total_tokens":366,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0},"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":328,"cost":0,"opencode":{"billing_source":"go","list_cost":0.000144,"allowance":0.0000864,"tokens":{"input":328,"output":38,"reasoning":0,"cache_read":0,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
];

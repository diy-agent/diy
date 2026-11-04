// text-only.gen.ts — 最基础：纯文本回复，无工具无思考
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts text-only
// 录制于 2026-11-04T06:26:59.982Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const textOnly = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"gw-b177560bc249-180b44","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:27:02.000Z"},
    {"type":"reasoning-start","id":"reasoning-0"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"We"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" need answer exactly four Chinese"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" characters? \"收到收到"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"\" is four"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" characters? "},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"收 "},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"到 收 到 ="},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" 4. Need"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" only"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" reply."},
    {"type":"reasoning-end","id":"reasoning-0"},
    {"type":"text-start","id":"txt-0"},
    {"type":"text-delta","id":"txt-0","delta":"收到收到"},
    {"type":"text-end","id":"txt-0"},
    {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":38,"noCache":38,"cacheRead":0},"outputTokens":{"total":36,"text":4,"reasoning":32},"raw":{"prompt_tokens":38,"completion_tokens":36,"total_tokens":74,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":32},"cost":0,"opencode":{"billing_source":"go","list_cost":0.0000546,"allowance":0.00003276,"tokens":{"input":38,"output":36,"reasoning":32,"cache_read":0,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
] as unknown as LanguageModelV3StreamPart[];

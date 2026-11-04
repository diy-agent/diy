// think.gen.ts — 带推理的回复（模型有 reasoning 面时才有效）
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts think
// 录制于 2026-11-04T06:27:23.338Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const think = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"gw-b152c5ccf5ec-f5bef","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:27:25.000Z"},
    {"type":"reasoning-start","id":"reasoning-0"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"We"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" need answer Chinese,"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" only conclusion."},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" Need be careful: 9"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":".11 vs 9."},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"9."},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" Numerically compare"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" decimals"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":": 9.11 ="},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" 9.11, "},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"9.9 = 9"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":".90. 9."},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"90 > 9.11"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":". So 9.9"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"大"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":". User"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" says think"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" then only conclusion."},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" Final should just conclusion"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":". \n"},
    {"type":"reasoning-end","id":"reasoning-0"},
    {"type":"text-start","id":"txt-0"},
    {"type":"text-delta","id":"txt-0","delta":"9.9 "},
    {"type":"text-delta","id":"txt-0","delta":"大。"},
    {"type":"text-end","id":"txt-0"},
    {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":53,"noCache":53,"cacheRead":0},"outputTokens":{"total":85,"text":8,"reasoning":77},"raw":{"prompt_tokens":53,"completion_tokens":85,"total_tokens":138,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":77},"cost":0,"opencode":{"billing_source":"go","list_cost":0.0001179,"allowance":0.00007074,"tokens":{"input":53,"output":85,"reasoning":77,"cache_read":0,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
] as unknown as LanguageModelV3StreamPart[];

// textOnly.ts — 最基础：纯文本回复，无工具无思考
// 自动生成，勿手改。重录：node tools/record-llm.mts text-only
// 录制于 2026-11-04T06:22:09.081Z · model=deepseek-v4.1-flash
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const textOnly: LanguageModelV3StreamPart[] = [
    {"type":"stream-start","warnings":[]},
    {"type":"response-metadata","id":"chatcmpl-8379363a5bb89cb8","modelId":"deepseek-v4.1-flash","timestamp":"2026-11-04T06:22:10.000Z"},
    {"type":"reasoning-start","id":"reasoning-0"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"我们需要"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":"只回复四个字“收到收到”。但注意“收到收到”是四个汉字？收 到 收 到"},
    {"type":"reasoning-delta","id":"reasoning-0","delta":" 四个字。直接回复。"},
    {"type":"reasoning-end","id":"reasoning-0"},
    {"type":"text-start","id":"txt-0"},
    {"type":"text-delta","id":"txt-0","delta":"收到收到"},
    {"type":"text-end","id":"txt-0"},
    {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":38,"noCache":38,"cacheRead":0},"outputTokens":{"total":37,"text":4,"reasoning":33},"raw":{"prompt_tokens":38,"completion_tokens":37,"total_tokens":75,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":33},"cost":0,"opencode":{"billing_source":"go","list_cost":0.0000558,"allowance":0.00003348,"tokens":{"input":38,"output":37,"reasoning":33,"cache_read":0,"cache_write_5m":0,"cache_write_1h":0}}}},"providerMetadata":{"diy-test-llm":{}}},
];

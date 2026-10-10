// tests/fixtures/models.ts
// 🎯 单测夹具：一份「用户已配置 opencode-go」的运行时目录。
//
// 生产**没有**内置 provider（无配置 = 空目录，见 shared/models.ts），所以单测要自发装配。
// 这里手写 4 个模型的元数据（含 diy 实测的 reasoning 档位与 responses 面），
// 供 tests/setup.ts 注入 —— 让不依赖磁盘 snapshot 的 core 单测开箱可用。
import type { ResolvedModel } from "../../src/shared/models";

const TTL = 60 * 60 * 1000;
const base = {
    provider: "opencode-go",
    kind: "std" as const,
    account: "0",
    baseUrl: "https://opencode.ai/zen/go/v1",
    npm: "@ai-sdk/openai-compatible",
    key: "$OPENCODE_API_KEY",
};

/** 缺省夹具人物的模型 ref（tests/setup.ts 写的 personas.yaml 引用它） */
export const FIXTURE_DEFAULT_REF = "0@opencode-go/mimo-v2.6-flash";

export const OPENCODE_GO_SNAPSHOT: ResolvedModel[] = [
    { ...base, id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "chat", contextLimit: 1048576, maxOutputTokens: 131072, reasoning: { supported: ["default", "none", "low", "medium", "high"], default: "medium" }, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, cacheTtlMs: TTL, ref: "0@opencode-go/mimo-v2.6-flash" },
    { ...base, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "chat", contextLimit: 1000000, maxOutputTokens: 384000, reasoning: { supported: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"], default: "medium" }, cost: { input: 0.15, output: 0.6, cacheRead: 0.003 }, cacheTtlMs: TTL, ref: "0@opencode-go/deepseek-v4.1-flash" },
    { ...base, id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000, reasoning: { supported: ["default", "none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [{ above: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] }, cacheTtlMs: TTL, ref: "0@opencode-go/gpt-5.6-luna", npm: "@ai-sdk/openai" },
    { ...base, id: "gpt-6-luna", name: "GPT 6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000, reasoning: { supported: ["default", "none", "low", "medium", "high", "xhigh", "max"], default: "medium" }, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ above: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }, cacheTtlMs: TTL, ref: "0@opencode-go/gpt-6-luna", npm: "@ai-sdk/openai" },
];

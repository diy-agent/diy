// env.ts — 测试用真模型的**唯一入口**
//
// 设计（2026-11-04 用户定）：测试代码**不读数据根 / 不用 bot 配置**，只认这三个环境变量：
//
//   DIY_TEST_LLM_BASE_URL   例 https://opencode.ai/inference/go/openai/v1
//   DIY_TEST_LLM_KEY        例 $OPENCODE_API_KEY（展开前是变量名，装配时才取值）
//   DIY_TEST_LLM_MODEL      例 deepseek-v4.1-flash
//
// 为什么这样：bot 配置属于**运行时状态**（可能被 UI 改、被 seed 覆盖、随版本迁移），
// 拿它当测试输入 ⇒ 测试结果取决于"本机当前怎么配的"。env 是**测试自己的输入**，
// 与运行时状态解耦，CI 里也不依赖任何数据根。

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export interface TestLlmConfig {
    readonly baseURL: string;
    readonly apiKey: string;
    readonly model: string;
}

/** 读 env；缺任何一项返回 null（调用方据此 skip，而不是让测试变红） */
export function testLlmConfig(env: Record<string, string | undefined> = process.env): TestLlmConfig | null {
    const baseURL = env["DIY_TEST_LLM_BASE_URL"]?.trim();
    const rawKey = env["DIY_TEST_LLM_KEY"]?.trim();
    const model = env["DIY_TEST_LLM_MODEL"]?.trim();
    if (!baseURL || !rawKey || !model) return null;
    // KEY 允许写 `$VAR` 形式（CI 里注入真实值，本地从 shell 展开）
    const apiKey = rawKey.startsWith("$") ? (env[rawKey.slice(1)] ?? "") : rawKey;
    if (apiKey === "") return null;
    return { baseURL, apiKey, model };
}

/** 缺环境变量时给一句人话，别让测试只报 skip */
export function missingEnvText(): string {
    return [
        "未配置测试用真模型，跳过：",
        "  export DIY_TEST_LLM_BASE_URL=https://opencode.ai/inference/go/openai/v1",
        "  export DIY_TEST_LLM_KEY=$OPENCODE_API_KEY",
        "  export DIY_TEST_LLM_MODEL=deepseek-v4.1-flash",
    ].join("\n");
}

/** 装配真模型（缺 env 抛错 —— 只在确定要跑真模型的路径调用） */
export function testLlm(env: Record<string, string | undefined> = process.env): {
    model: LanguageModel;
    config: TestLlmConfig;
} {
    const config = testLlmConfig(env);
    if (config === null) throw new Error(missingEnvText());
    // opencode-go 的上游要求 `x-opencode-session`，否则 400 MissingSessionID
    // （见 docs/model-testing.md「free 模型核对流程」）。别的 baseURL 不需要，
    // 所以按域名判断；要额外头用 DIY_TEST_LLM_HEADERS 传 JSON 覆盖。
    const extra: Record<string, string> = JSON.parse(env["DIY_TEST_LLM_HEADERS"] ?? "{}") as Record<string, string>;
    const headers =
        config.baseURL.includes("opencode.ai") && extra["x-opencode-session"] === undefined
            ? { ...extra, "x-opencode-session": `diy-test-${Date.now()}` }
            : extra;
    const provider = createOpenAICompatible({
        name: "diy-test-llm",
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        headers,
    });
    return { model: provider(config.model) as unknown as LanguageModel, config };
}

// src/model-ports.ts
// 🎯 把模型接成 Agent 聚合的 `AgentPorts`（S2）。
//
// 关键发现（省掉一层）：`LlmProvider extends LlmPort`（`pkgs.ts/model/provider/src/openai.ts:35`），
// 也就是说 provider 本来就是 **session 的 LlmPort**（`chat(messages) → AsyncGenerator<SessionDelta>`）。
// 所以不需要 ai-sdk 的 `streamText`，直接把 SessionDelta 里的文本片段转成 Agent 的字符串流即可 ——
// 少一个依赖、少一层错误面。

import type { LlmPort } from "@diy-agent/session";
import { createOpenAiCompatible, resolveProviderConfig } from "@diy-agent/llm-provider";
import { loadCatalog, readAccountValue } from "@diy-agent/model-catalog";
import { splitModelKey } from "./chat.js";
import type { AgentPorts } from "./aggregate.js";

/**
 * 把 LlmPort 包成 Agent 的 port：只取文本增量。
 * 思考增量（reasoning）**不丢**，用 `thinking` 段落的形式带出去 —— 聚合层可以决定要不要显示，
 * 但不该在传输层就把它扔掉（丢掉之后再也拿不回来）。
 */
export function llmPorts(provider: LlmPort): AgentPorts {
    return {
        async *complete(messages) {
            const wire = messages.map((m) => ({
                role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as
                    | "user"
                    | "assistant"
                    | "system",
                text: m.content,
            }));
            for await (const delta of provider.chat(wire)) {
                if (delta.type === "text") yield delta.text;
            }
        },
    };
}

/**
 * 按 `account@provider/model` 解析出 LlmPort。
 *
 * 与 `chat.ts` 同一套解析链（splitModelKey → readAccountValue → catalog.baseURL），
 * 但**解析失败就抛**，不静默退回假模型 —— 否则界面显示"能聊"却永远没有回答。
 */
export function resolveProvider(home: string, modelKey: string): LlmPort {
    const { account, providerId, modelId } = splitModelKey(modelKey);
    if (providerId === "" || modelId === "") {
        throw new Error(`模型标识不合法：${modelKey}（应形如 account@provider/model）`);
    }
    const apiKey = readAccountValue(home, providerId, account);
    if (!apiKey) throw new Error(`找不到 ${providerId} 的 API key（数据根 ${home}）`);
    const entry = loadCatalog(home).find((e) => e.modelId === modelId);
    try {
        return createOpenAiCompatible(
            resolveProviderConfig({ provider: providerId, apiKey, model: modelId, baseURL: entry?.baseURL }),
        );
    } catch {
        if (entry?.baseURL === undefined) {
            throw new Error(`provider ${providerId} 不在 provider 表里，且模型目录里没有它的 baseURL`);
        }
        return createOpenAiCompatible({ name: providerId, baseURL: entry.baseURL, apiKey, model: modelId });
    }
}

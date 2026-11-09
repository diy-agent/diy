// src/model-ports.ts
// 🎯 把模型接成 Agent 聚合的 `AgentPorts`（S2）。
//
// 关键发现（省掉一层）：`LlmProvider extends LlmPort`（`pkgs.ts/model/provider/src/openai.ts:35`），
// 也就是说 provider 本来就是 **session 的 LlmPort**（`chat(messages) → AsyncGenerator<SessionDelta>`）。
// 所以不需要 ai-sdk 的 `streamText`，直接把 SessionDelta 里的文本片段转成 Agent 的字符串流即可 ——
// 少一个依赖、少一层错误面。

import type { LlmPort } from "@diy-agent/session";
import { createOpenAiCompatible, resolveProviderConfig } from "@diy-agent/llm-provider";
import { listAccountStates, loadCatalog, readAccountValue } from "@diy-agent/model-catalog";
import { splitModelKey } from "./chat.js";
import type { AgentPorts } from "./aggregate.js";
import type { ModelChoice } from "./protocol.js";

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

/**
 * 模型选择器数据（与 `createBotChat` 的 `choices()` 同一口径）：
 * 展开**已配置**的账号（`account@provider/model` 三段式），一个都没配的 provider 退回两段式。
 *
 * 为什么在 bot 包里而不是让宿主自己拼：`account` 决定取哪把 key —— 只列 provider/model 时
 * 用户无法表达「用 aug 这个账号」，取 key 就只能拿第一个（实测表现成上游超时）。
 */
export function modelChoices(home: string): ModelChoice[] {
    const accountsByProvider = new Map(
        listAccountStates(home).map((p) => [p.providerId, p.accounts.filter((a) => a.configured).map((a) => a.name)]),
    )
    const out: ModelChoice[] = []
    for (const entry of loadCatalog(home)) {
        const base = {
            providerId: entry.providerId,
            modelId: entry.modelId,
            ...(entry.cost === undefined ? {} : { cost: entry.cost }),
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        }
        const accounts = accountsByProvider.get(entry.providerId) ?? []
        if (accounts.length === 0) {
            out.push({ ...base, name: entry.name })
            continue
        }
        for (const account of accounts) out.push({ ...base, account, name: entry.name })
    }
    return out
}

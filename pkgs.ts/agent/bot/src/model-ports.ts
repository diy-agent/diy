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
export function llmPorts(provider: LlmPort, opts: { sessionId?: string } = {}): AgentPorts {
    return {
        async *complete(messages, completeOpts) {
            const wire = messages.map((m) => ({
                role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as
                    | "user"
                    | "assistant"
                    | "system",
                text: m.content,
            }));
            // ⚠️ 必须带 sessionId：provider 的 `$SESSION` 模板 header（如 opencode-go 的会话亲和键）
            // 只有拿到它才会补；缺了以后上游可能不回应（实测表现就是「请求超时」）。
            // 工具：provider 把 `tools` 交给 ai-sdk 的 streamText，由 `stopWhen: stepCountIs(maxSteps)`
            // 跑完整个工具循环 —— 这里只透传，不自己写循环（##514 的教训：自己写 = 重新踩坑）。
            const chatOpts = {
                ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
                ...(completeOpts?.tools === undefined
                    ? {}
                    : {
                          tools: completeOpts.tools,
                          // 2026-11-10 用户：「把 diy2 的 8 次限制去掉」。
                          // provider 侧用 stopWhen: stepCountIs(maxSteps)；maxSteps 为 undefined 时
                          // **根本不传 stopWhen**（model/provider/src/openai.ts:158）⇒ 不限步数。
                          // 原来这里写死 8，让每个会话最多 8 轮工具调用，长活（重构、批量改）会硬停。
                          ...(completeOpts.maxSteps === undefined ? {} : { maxSteps: completeOpts.maxSteps }),
                      }),
            };
            for await (const delta of provider.chat(wire, Object.keys(chatOpts).length === 0 ? undefined : chatOpts)) {
                if (delta.type === "text") yield delta.text;
                else if (delta.type === "tool-call") yield { type: "tool-call", id: delta.id, name: delta.name, input: delta.input };
                else if (delta.type === "tool-result") yield { type: "tool-result", id: delta.id, content: delta.content };
                else if (delta.type === "usage")
                    yield {
                        type: "usage",
                        inputTokens: delta.inputTokens,
                        outputTokens: delta.outputTokens,
                        ...(delta.cacheReadTokens === undefined ? {} : { cacheReadTokens: delta.cacheReadTokens }),
                    };
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
    // ⚠️ 必须**同时**匹配 providerId + modelId：同一个 modelId 可能挂在多个 provider 下
    // （deepseek / opencode-go …），只按 modelId 找会拿到别人的 baseURL ⇒ 请求发到错的端点、
    // 上游不回应（实测表现就是「请求超时」）。
    const entry = loadCatalog(home).find((e) => e.providerId === providerId && e.modelId === modelId);
    if (entry === undefined) throw new Error(`模型目录里没有 ${providerId}/${modelId}（model.yaml 可能变了）`);
    try {
        return createOpenAiCompatible(
            resolveProviderConfig({ provider: providerId, apiKey, model: modelId, baseURL: entry.baseURL }),
        );
    } catch {
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

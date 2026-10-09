// src/main/core/model-runtime.ts
// 🎯 provider 配置 → **运行时模型目录**的装配：把 registryView（snapshot ⊕ custom ⊕ config）
// 解析成 ResolvedModel[]，灌进 shared/models.ts 的可变目录供全局查询。
//
// 何时刷新：应用启动 + `llmConfig.write` 落盘后（改配置立即生效，无需重启 —— 与 limits.json
// 的"改文件需重启"不同，因为这里有显式的写入口，能拿到刷新时机）。
//
// API 面（chat/responses）models.dev **没有**这个粒度（npm 是 provider 级的粗定面），
// 故：逐模型覆盖（ModelOverride.api）> 内置 responses-only 名单 > npm 推导。

import {
    BUILTIN_MODELS,
    setModelCatalog,
    type LocalModelReasoning,
    type ResolvedModel,
} from "../../shared/models";
import type { ModelCost } from "../../shared/usage";
import { expandEnvValue, registryView } from "./model-registry";

/**
 * spec/override 的 cost 是 **models.dev 的 snake_case**（`cache_read`/`cache_write`），
 * 而计价口径 `ModelCost`/`ratesOf` 读 **camelCase**（`cacheRead`/`cacheWrite`）——
 * 不转就会把缓存读单价丢掉（按 0 算，静默低估成钱）。缺 input/output 视为无价。
 */
function toModelCost(
    c: { input?: number; output?: number; cache_read?: number; cache_write?: number } | null | undefined,
): ModelCost | undefined {
    if (!c || c.input === undefined || c.output === undefined) return undefined;
    return { input: c.input, output: c.output, cacheRead: c.cache_read, cacheWrite: c.cache_write };
}

/** 无档位信息时的保守档位集（models.dev 只有 reasoning 布尔位，没有词表） */
const GENERIC_REASONING: LocalModelReasoning = {
    supported: ["none", "low", "medium", "high", "xhigh", "max"],
    default: "medium",
};
const OFF_REASONING: LocalModelReasoning = { supported: ["none"], default: "none" };

/**
 * 装配运行时目录。无任何已配置 provider → 回退内置 zen/go（开箱即用）。
 * 返回装配结果（模型数），便于日志/测试。
 */
export function refreshModelRuntime(home: string): number {
    const view = registryView(home);
    const models: ResolvedModel[] = [];
    for (const p of view.providers) {
        if (!p.spec) continue; // 无 spec（snapshot 改版 / custom spec 未写）→ 跳过
        for (const m of p.models) {
            if (!m.enabled) continue;
            const builtin = BUILTIN_MODELS.find((b) => b.id === m.id);
            const api = m.api; // 已由 modelViews 解析（override > 内置 responses 名单 > chat）
            const reasoning =
                m.reasoningOverride ??
                builtin?.reasoning ??
                (m.reasoning ? GENERIC_REASONING : OFF_REASONING);
            const cost = toModelCost(m.cost) ?? builtin?.cost;
            const context = m.context ?? builtin?.contextLimit ?? 0;
            const output = m.output ?? builtin?.maxOutputTokens ?? 0;
            for (const a of p.accounts) {
                models.push({
                    id: m.id,
                    name: m.name,
                    api,
                    contextLimit: context,
                    maxOutputTokens: output,
                    reasoning,
                    cost: cost ?? undefined,
                    cacheTtlMs: builtin?.cacheTtlMs,
                    ref: `${a.label}@${p.limited}/${m.id}`,
                    provider: p.limited,
                    kind: p.kind,
                    account: a.label,
                    baseUrl: p.spec.api,
                    npm: p.spec.npm,
                    // 展开成功取展开值；展开失败保留**原始 value**（含 $VAR），
                    // 交给 resolveModelKey 报出具体变量名（比"未配置"更有指向性）。
                    key: a.error ? a.account.data.value : a.expanded,
                });
            }
        }
    }
    setModelCatalog(models);
    return models.length;
}

/** 解析模型 key（$VAR 展开）—— 供 local-agent 在真正发请求前调用（未定义 → 抛错） */
export function resolveModelKey(model: ResolvedModel): string {
    if (model.key === null) throw new Error(`模型 ${model.ref} 的账号密钥未配置`);
    const { value, error } = expandEnvValue(model.key);
    if (error || value === null) throw new Error(`模型 ${model.ref}：${error ?? "密钥展开失败"}`);
    return value;
}

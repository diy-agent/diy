// src/main/core/model-runtime.ts
// 🎯 provider 配置 → **运行时模型目录**的装配：把 registryView（snapshot ⊕ custom ⊕ config）
// 解析成 ResolvedModel[]，灌进 shared/models.ts 的可变目录供全局查询。
//
// 何时刷新：应用启动 + `llmConfig.write` / `llmConfig.writeSpec` 落盘后（改配置立即生效）。
//
// **没有内置 provider**：无任何已配置 provider → 目录为空（模型元数据全部来自 snapshot ⊕ custom
// spec，代码里不硬编码模型清单）。API 面由 npm 解析（见 model-registry.modelViews / faceOfNpm）。

import { setModelCatalog, type LocalModelReasoning, type ResolvedModel } from "../../shared/models";
import type { ModelCost } from "../../shared/usage";
import { expandEnvValue, registryView } from "./model-registry";

/**
 * spec/override 的 cost 是 **models.dev 的 snake_case**（`cache_read`/`cache_write`），
 * 而计价口径 `ModelCost` 读 **camelCase**（`cacheRead`/`cacheWrite`）——不转就会把缓存读单价丢掉
 * （按 0 算，静默低估成钱）。tiers 的 `tier.size` 映射到 `ModelTier.above`。
 */
function toModelCost(
    c:
        | {
              input?: number;
              output?: number;
              cache_read?: number;
              cache_write?: number;
              tiers?: Array<{ input?: number; output?: number; cache_read?: number; cache_write?: number; tier?: { size?: number } }>;
          }
        | null
        | undefined,
): ModelCost | undefined {
    if (!c || c.input === undefined || c.output === undefined) return undefined;
    const tiers = (c.tiers ?? [])
        .map((t) => ({
            above: t.tier?.size ?? 0,
            input: t.input ?? c.input!,
            output: t.output ?? c.output!,
            cacheRead: t.cache_read,
            cacheWrite: t.cache_write,
        }))
        .filter((t) => t.above > 0);
    return {
        input: c.input,
        output: c.output,
        cacheRead: c.cache_read,
        cacheWrite: c.cache_write,
        ...(tiers.length ? { tiers } : {}),
    };
}

/** 无档位词表时的保守档位集（models.dev 通常只有 reasoning 布尔位，没有词表） */
const GENERIC_REASONING: LocalModelReasoning = {
    supported: ["none", "low", "medium", "high", "xhigh", "max"],
    default: "medium",
};
const OFF_REASONING: LocalModelReasoning = { supported: ["none"], default: "none" };

/**
 * 装配运行时目录。无任何已配置 provider → 空目录（**不回退内置**）。
 * 返回装配结果（模型引用数），便于日志/测试。
 */
export function refreshModelRuntime(home: string): number {
    const view = registryView(home);
    const models: ResolvedModel[] = [];
    for (const p of view.providers) {
        if (!p.spec) continue; // 无 spec（snapshot 改版 / custom spec 未写）→ 跳过
        for (const m of p.models) {
            if (!m.enabled) continue;
            const reasoning = m.reasoningOverride ?? (m.reasoning ? GENERIC_REASONING : OFF_REASONING);
            const cost = toModelCost(m.cost);
            for (const a of p.accounts) {
                models.push({
                    id: m.id,
                    name: m.name,
                    api: m.api,
                    contextLimit: m.context ?? 0,
                    maxOutputTokens: m.output ?? 0,
                    reasoning,
                    cost,
                    ref: `${a.label}@${p.limited}/${m.id}`,
                    provider: p.limited,
                    kind: p.kind,
                    account: a.label,
                    baseUrl: p.spec.api,
                    npm: m.npm,
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

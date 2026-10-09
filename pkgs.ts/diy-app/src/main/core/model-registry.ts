// src/main/core/model-registry.ts
// 🎯 provider 注册表：snapshot（内置 spec）+ custom spec + model.yaml（配置）→ UI/运行时视图。
//
// 数据流（谁也不覆盖谁，按 id 关联）：
//   spec 层  = models-snapshot.json（models.dev npm 白名单产物，唯一真源）
//             + $DIY_HOME/providers.custom.yaml（models.dev 没有的 provider）
//   配置层   = $DIY_HOME/model.yaml（accounts/filter/models 覆盖 —— 零 models.dev 字段）
//   视图     = spec ⊕ override（白名单字段）＋ filter 判定 ＋ $VAR 展开
//
// snapshot 用 **fs 惰性读** 而不是 import：4.3MB JSON 一旦被 import，
// tsc 的 resolveJsonModule 会尝试把它推断成字面量类型（6315 模型 → 实例化爆炸）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    filterAllows,
    type AccountView,
    type CatalogEntry,
    type Filter,
    type LlmConfigView,
    type ModelOverride,
    type ModelView,
    type ProviderConfig,
    type ProviderView,
    type SpecProvider,
} from "../../shared/model-config";
import { loadCustomSpecs, loadModelConfig } from "./model-config";

let _snapshot: Record<string, SpecProvider> | null = null;

/** 惰性加载 snapshot（进程内缓存一次） */
function snapshot(): Record<string, SpecProvider> {
    if (_snapshot) return _snapshot;
    const here = dirname(fileURLToPath(import.meta.url));
    const cands = [
        join(here, "../data/models-snapshot.json"), // out/main/data（build 拷贝）
        join(here, "../../src/main/data/models-snapshot.json"), // 源树（tsx 直跑兜底）
    ];
    const p = cands.find((c) => existsSync(c));
    if (!p) throw new Error(`models-snapshot.json 缺失: ${cands.join(" | ")}`);
    _snapshot = JSON.parse(readFileSync(p, "utf-8")) as Record<string, SpecProvider>;
    return _snapshot;
}

/**
 * `$VAR` / `${VAR}` 展开（就地，只认环境变量；不做 `!command`）。
 * 未定义 → error（**fail-fast**：你制定了环境变量却不提供，当然报错）。
 * UI 读取时只标红不炸页；真正调用上游时按同一结果 fail-fast。
 */
export function expandEnvValue(v: string): { value: string | null; error: string | null } {
    if (!v.includes("$")) return { value: v, error: null };
    let error: string | null = null;
    const out = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, bare) => {
        const name = braced ?? bare;
        const val = process.env[name];
        if (val === undefined) {
            error ??= `环境变量 $${name} 未定义`;
            return m;
        }
        return val;
    });
    return error ? { value: null, error } : { value: out, error: null };
}


function accountViews(accounts: ProviderConfig["accounts"]): AccountView[] {
    return accounts.map((a, i) => {
        const { value, error } = expandEnvValue(a.data.value);
        return { index: i, label: a.name ?? String(i), account: a, expanded: value, error };
    });
}

function modelViews(
    spec: SpecProvider | null,
    overrides: Record<string, ModelOverride>,
    filter: Filter,
): ModelView[] {
    const specIds = spec ? Object.keys(spec.models) : [];
    const ids = [...specIds, ...Object.keys(overrides).filter((id) => !specIds.includes(id))];
    return ids.map((id) => {
        const m = spec?.models[id];
        const o = overrides[id];
        return {
            id,
            name: o?.name ?? (m?.name as string | undefined) ?? id,
            context: o?.limit?.context ?? m?.limit?.context ?? null,
            output: o?.limit?.output ?? m?.limit?.output ?? null,
            reasoning: m?.reasoning ?? false,
            reasoningOverride: o?.reasoning ?? null,
            cost: o?.cost ?? ((m?.cost as { input?: number; output?: number } | undefined) ? { input: m!.cost!.input, output: m!.cost!.output } : null),
            enabled: filterAllows(filter, id),
            overridden: o !== undefined,
            specMissing: m === undefined,
        };
    });
}

function providerView(
    kind: "std" | "custom",
    key: string,
    config: ProviderConfig,
    spec: SpecProvider | null,
): ProviderView {
    const limited = kind === "custom" ? `custom:${key}` : key;
    const filter: Filter = config.filter ?? { include: [], exclude: [] };
    const overrides: Record<string, ModelOverride> = config.models ?? {};
    const accounts = accountViews(config.accounts);
    const models = modelViews(spec, overrides, filter);
    return {
        key,
        kind,
        limited,
        spec: spec
            ? { id: spec.id, name: spec.name ?? null, npm: spec.npm, api: spec.api, env: spec.env ?? [] }
            : null,
        config: { accounts: config.accounts, filter, models: overrides },
        accounts,
        models,
        usable: accounts.some((a) => a.expanded !== null),
    };
}

/** 全量视图（llmConfig.read） */
export function registryView(home: string): LlmConfigView {
    const cfg = loadModelConfig(home);
    const customSpecs = loadCustomSpecs(home);
    const snap = snapshot();
    const catalog: CatalogEntry[] = Object.values(snap).map((p) => ({
        id: p.id,
        name: p.name ?? null,
        npm: p.npm,
        api: p.api,
        env: p.env ?? [],
    }));
    const providers: ProviderView[] = [
        ...Object.entries(cfg.stdProviders).map(([key, config]) =>
            providerView("std", key, config, snap[key] ?? null),
        ),
        ...Object.entries(cfg.customProviders).map(([key, config]) =>
            providerView("custom", key, config, customSpecs[key] ?? null),
        ),
    ];
    return { modelFile: cfg, customSpecs, catalog, providers };
}

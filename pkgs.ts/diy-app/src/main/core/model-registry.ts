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

import { readFileSync } from "node:fs";
import { calendarLabel } from "../../shared/calendars";
import { faceOfNpm } from "../../shared/models";
import {
    filterAllows,
    reasoningFromSpec,
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
import { calendars } from "./calendars";
import { dataFileOrThrow } from "./data-file";
import { loadCustomSpecs, loadModelConfig } from "./model-config";

let _snapshot: Record<string, SpecProvider> | null = null;

/** 惰性加载 snapshot（进程内缓存一次） */
function snapshot(): Record<string, SpecProvider> {
    if (_snapshot) return _snapshot;
    _snapshot = JSON.parse(readFileSync(dataFileOrThrow("models-snapshot.json"), "utf-8")) as Record<string, SpecProvider>;
    return _snapshot;
}

/**
 * 取 snapshot 的单个 provider 条目（含 models）；未收录 = null。
 * 价目登记（`main/core/llm-cost.ts`）用它取 std provider 的 spec —— 裸 id 判 std/custom 也用它。
 * ⚠️ 首次调用会解析整份 snapshot（进程内缓存一次），别在热路径高频调。
 */
export function snapshotProvider(id: string): SpecProvider | null {
    return snapshot()[id] ?? null;
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
        // 空值 = 还没填（不是错误，运行时该账号不可用）：expanded=null、error=null。
        const { value, error } = a.data.value.trim() === "" ? { value: null, error: null } : expandEnvValue(a.data.value);
        return { index: i, label: a.name ?? String(i), account: a, expanded: value, error };
    });
}

function modelViews(
    spec: SpecProvider | null,
    overrides: Record<string, ModelOverride>,
    filter: Filter,
): ModelView[] {
    const specModels = spec?.models ?? {}; // custom spec 未写 models 时是 undefined
    const specIds = Object.keys(specModels);
    const ids = [...specIds, ...Object.keys(overrides ?? {}).filter((id) => !specIds.includes(id))];
    const out: ModelView[] = [];
    for (const id of ids) {
        const m = specModels[id];
        const o = (overrides ?? {})[id];
        // 面由 npm 解析：模型级 `provider.npm` 覆写 > provider 级 `npm`（对齐 models.dev）。
        const npm = (m?.provider as { npm?: string } | undefined)?.npm ?? spec?.npm ?? "";
        const face = faceOfNpm(npm);
        if (!face) continue; // 不支持的 npm（anthropic/google/…）→ 该模型不出现
        const sc = m?.cost;
        // 覆盖（model.yaml，可含时段档）优先；否则取 spec 的价（models.dev 原生 / custom 自写）。
        const cost =
            o?.cost ??
            (sc && (sc.input !== undefined || sc.output !== undefined)
                ? { input: sc.input, output: sc.output, cache_read: sc.cache_read, cache_write: sc.cache_write, baseLabel: sc.baseLabel, tiers: sc.tiers }
                : null);
        // 档位：配置覆盖 > models.dev 的 reasoning_options（effort 词表）> 兜底/关闭。
        const declaredSupport = reasoningFromSpec(m?.reasoning, m?.reasoning_options);
        const reasoning = o?.reasoning
            ? { supported: o.reasoning.supported, default: o.reasoning.default, declared: true }
            : declaredSupport;
        out.push({
            id,
            name: o?.name ?? (m?.name as string | undefined) ?? id,
            context: o?.limit?.context ?? m?.limit?.context ?? null,
            output: o?.limit?.output ?? m?.limit?.output ?? null,
            api: face,
            npm,
            reasoning,
            cost: cost as ModelView["cost"],
            enabled: filterAllows(filter, id),
            specMissing: m === undefined,
        });
    }
    // 展示顺序 = 价格从低到高（便宜的先看见；无价排后）。UI 模型平铺按钮照此渲染。
    out.sort((a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id));
    return out;
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
    // 注：config.models 覆盖仍被 schema 保留（档位兜底登记），本 UI 不暴露。
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
        usable: accounts.some((a) => a.expanded !== null && a.expanded !== ""),
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
    // 日历清单（时段档的「工作日扩展」下拉项）：只下 id + 展示名，整表留在 main 侧
    const tables = calendars();
    const calendarChoices = Object.entries(tables).map(([id, def]) => ({ id, label: calendarLabel(def, id) }));
    return { modelFile: cfg, customSpecs, catalog, providers, calendars: calendarChoices };
}

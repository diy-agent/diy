// src/main/core/model-runtime.ts
// 🎯 provider 配置 → **运行时模型目录**的装配：把 registryView（snapshot ⊕ custom ⊕ config）
// 解析成 ResolvedModel[]，灌进 shared/models.ts 的可变目录供全局查询。
//
// 何时刷新：应用启动 + `llmConfig.write` / `llmConfig.writeSpec` 落盘后（改配置立即生效）。
//
// **没有内置 provider**：无任何已配置 provider → 目录为空（模型元数据全部来自 snapshot ⊕ custom
// spec，代码里不硬编码模型清单）。API 面由 npm 解析（见 model-registry.modelViews / faceOfNpm）。

import { parseTimeOfDay } from "../../shared/calendars";
import { setCalendarCatalog, setModelCatalog, type ResolvedModel } from "../../shared/models";
import type { ModelCost, ModelTier, TierWhen } from "../../shared/usage";
import { calendars } from "./calendars";
import { expandEnvValue, registryView } from "./model-registry";

/** spec/override 的 cost 条目（models.dev snake_case ⊕ diy 的 utc-range 扩展） */
interface SpecCostTier {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tier?: { type?: string; size?: number; data?: Record<string, unknown> };
}

interface SpecCost {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    baseLabel?: string;
    tiers?: SpecCostTier[];
}

/**
 * spec/override 的 `tier` → 运行时 `TierWhen`（判别联合）。
 *   · `context`   —— `{type:"context", size}`（models.dev 原生）或 `{type:"context", data:{size}}`
 *   · `utc-range` —— `{type:"utc-range", data:{start, end, calendar?, label?}}`
 * **认不出的档一律 warn 丢弃**（不静默按 base 价收钱 —— 丢档 = 静默少算/多算）。
 *
 * ⚠️ 本函数是「档触发条件」的**最后一道哨**：`providers.custom.yaml` / `model.yaml` 走写侧 zod，
 * 但 **snapshot（models.dev 产物）是 `JSON.parse` 直取、无校验**（见 model-registry.snapshot）。
 * 上游把 `size` 写成字符串、或发个没见过的 `type`，全靠这里挡 —— 挡住 = 丢档（价目其余部分照用），
 * 放过去 = 该档阈值退化成 0/NaN（"永远比不过"的死档），长上下文的钱静默少收。
 * 故导出：直接单测这条判别边界（不必伪造 snapshot 文件）。
 */
export function toTierWhen(tier: SpecCostTier["tier"], id: string): TierWhen | null {
    if (!tier?.type) return null;
    if (tier.type === "context") {
        // 不能盲 cast：`data.size` 是 unknown（手写 YAML / 上游改形状都可能给字符串），
        // 非数字若放过去会变成「永远比不过」的死档（静默少算钱）。
        const declared = tier.size ?? tier.data?.size;
        const size = typeof declared === "number" && Number.isFinite(declared) ? declared : 0;
        if (size <= 0) {
            console.warn(`模型 ${id} 的 context 档缺 size → 丢档`);
            return null;
        }
        return { kind: "context", size };
    }
    if (tier.type === "utc-range") {
        const d = (tier.data ?? {}) as { start?: string; end?: string; calendar?: string; label?: string };
        const s = d.start ? parseTimeOfDay(d.start) : null;
        const e = d.end ? parseTimeOfDay(d.end) : null;
        if (!s || !e) {
            console.warn(`模型 ${id} 的 utc-range 档 start/end 非法（须带 UTC 偏移）→ 丢档`);
            return null;
        }
        if (s.offsetMs !== e.offsetMs) {
            console.warn(`模型 ${id} 的 utc-range 档 start/end 偏移不一致 → 丢档（歧义不猜）`);
            return null;
        }
        return {
            kind: "utc-range",
            startMin: s.minutes,
            endMin: e.minutes,
            offsetMs: s.offsetMs,
            ...(d.calendar ? { calendar: d.calendar } : {}),
            ...(d.label ? { label: d.label } : {}),
        };
    }
    console.warn(`模型 ${id} 的阶梯档 type="${tier.type}" 未支持 → 丢档`);
    return null;
}

/**
 * spec/override 的 cost 是 **models.dev 的 snake_case**（`cache_read`/`cache_write`），
 * 而计价口径 `ModelCost` 读 **camelCase**（`cacheRead`/`cacheWrite`）——不转就会把缓存读单价丢掉
 * （按 0 算，静默低估成钱）。档位触发条件转成判别联合 `TierWhen`（见 shared/usage.ts）。
 */
function toModelCost(c: SpecCost | null | undefined, id: string): ModelCost | undefined {
    if (!c || c.input === undefined || c.output === undefined) return undefined;
    const tiers: ModelTier[] = [];
    for (const t of c.tiers ?? []) {
        const when = toTierWhen(t.tier, id);
        if (!when) continue;
        // 档内缺字段**逐项回退 base**（含缓存价）：峰谷价通常只改 in/out，缓存读若按「无值→
        // 输入价兜底」（见 usage.costBreakdown）会比 base 的缓存价贵几十倍，故这里先继承。
        tiers.push({
            when,
            input: t.input ?? c.input!,
            output: t.output ?? c.output!,
            cacheRead: t.cache_read ?? c.cache_read,
            cacheWrite: t.cache_write ?? c.cache_write,
        });
    }
    return {
        input: c.input,
        output: c.output,
        cacheRead: c.cache_read,
        cacheWrite: c.cache_write,
        ...(c.baseLabel ? { baseLabel: c.baseLabel } : {}),
        ...(tiers.length ? { tiers } : {}),
    };
}

/**
 * 装配运行时目录。无任何已配置 provider → 空目录（**不回退内置**）。
 * 返回装配结果（模型引用数），便于日志/测试。
 */
export function refreshModelRuntime(home: string): number {
    // 时段价的日历判定源（内置 calendars.json；缺失 = 空表 → 时段档全不命中，退 base 价）
    setCalendarCatalog(calendars());
    const view = registryView(home);
    const models: ResolvedModel[] = [];
    for (const p of view.providers) {
        if (!p.spec) continue; // 无 spec（snapshot 改版 / custom spec 未写）→ 跳过
        for (const m of p.models) {
            if (!m.enabled) continue;
            // 档位已由 model-registry 解析（models.dev reasoning_options ⊕ 配置覆盖 ⊕ 兜底）。
            const reasoning = { supported: m.reasoning.supported, default: m.reasoning.default };
            const cost = toModelCost(m.cost as SpecCost | null | undefined, m.id);
            for (const a of p.accounts) {
                models.push({
                    id: m.id,
                    name: m.name,
                    api: m.api,
                    // spec 未给 limit → **留 undefined**（不是 0！）：0 会被当成真实上限下发，
                    // SDK 直接拒（maxOutputTokens must be >= 1）。undefined 让运行时回退默认值
                    // （见 local-agent.modelOutputTokens / DEFAULT_LIMITS）。
                    contextLimit: m.context ?? undefined,
                    maxOutputTokens: m.output ?? undefined,
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

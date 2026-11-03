// src/main/core/llm-cost.ts
// 🎯 价目登记的**服务端实现**（CLI `llmConfig costs / setCost / setTiers` 的 handler 落地）。
//
// 为什么要有它：UI 编辑只覆盖「人在页面上点」，而 agent 需要能**用命令行登记价目** ——
// models.dev 没有 custom provider 的价，不登记就 `cost=null`（看板只见 token 不见钱）。
//
// 三件事在这里定性（UI 侧同样成立，只是 UI 只能落 spec）：
//   1. **价目该落在哪** —— `custom:<id>` → `providers.custom.yaml` 的 spec（自定义 provider 的
//      模型规格真源）；std provider → `model.yaml` 的**覆盖**（models.dev 的价在 snapshot 里，
//      我们只能加覆盖）。裸 id 先认 snapshot（收录即 std），`custom:` 前缀用于强制指定。
//   2. **覆盖不是"补丁"** —— 覆盖一旦存在就**整体**取代 spec 价（registryView 的 `o?.cost ?? spec`）
//      ⇒ 首次写覆盖时以 spec 价为**基线**（回执 `seededFromSpec`），否则"只填 output"会静默
//      丢掉 models.dev 的缓存读价（低估成钱）。改价前先读 `llmConfig costs` 的 `cost`/`costSource`。
//   3. **回执给"生效价"与"预警"** —— `cost`（该落点）与 `effective`（override > spec）分开，
//      再附 `warnings`（缺价/坏时刻/日历不存在 → 这个价会在哪类请求上算不出或算错）。
//
// 纯变换（合并/清字段/档位批量/预警判据）在 `shared/cost-edit.ts`，UI 与 CLI 同一套；
// 本文件只管「定位 → 改 → 落盘 → 回执」。
import { calendarLabel } from "../../shared/calendars";
import {
    applyCostPatch,
    clearUtcRangeTiers,
    costWarnings,
    dropUtcRangeTier,
    isEmptyCost,
    setUtcRangeTiers,
    utcRangeCount,
    type CostPatch,
} from "../../shared/cost-edit";
import {
    type Cost,
    type CostClearField,
    type CostSource,
    type CostTarget,
    type CostUpdateResult,
    type CustomSpecsFile,
    type ModelConfigFile,
    type ProviderCostsView,
    type SpecProvider,
    type TierWrite,
} from "../../shared/model-config";
import { faceOfNpm } from "../../shared/models";
import { calendars } from "./calendars";
import { windowChoices, windowTable } from "./cost-windows";
import { customSpecsFile, loadCustomSpecs, loadModelConfig, modelConfigFile, saveCustomSpecs, saveModelConfig } from "./model-config";
import { registryView, snapshotProvider } from "./model-registry";

/** `--target auto` 的解析：custom 的价天生属于 spec，std 只能加覆盖 */
export function defaultTarget(kind: "std" | "custom"): CostTarget {
    return kind === "custom" ? "spec" : "override";
}

interface Located {
    kind: "std" | "custom";
    /** 裸 id（custom 去掉 `custom:` 前缀） */
    id: string;
    /** 限定名（custom 恒带前缀） */
    limited: string;
    cfg: ModelConfigFile;
    specs: CustomSpecsFile;
    /** 生效 spec（std = snapshot 条目；custom = providers.custom.yaml 条目）；两处都没有 = null */
    spec: SpecProvider | null;
    /** provider 段是否已在 model.yaml（override 落地前提：没账号就无从落） */
    configured: boolean;
}

/** 解析 provider 引用 + 载入两个配置文件（写路径的唯一入口） */
function locate(home: string, ref: string): Located {
    const raw = ref.trim();
    if (!raw) throw new Error("provider 不能为空（裸 id 或 custom:<id>）");
    const cfg = loadModelConfig(home);
    const specs = loadCustomSpecs(home);
    let kind: "std" | "custom";
    let id: string;
    if (raw.startsWith("custom:")) {
        kind = "custom";
        id = raw.slice("custom:".length);
        if (!id) throw new Error("custom: 后要跟 provider id（如 custom:goat）");
    } else {
        // 裸 id：models.dev 收录即 std（要强制当 custom 就写 custom: 前缀）
        kind = snapshotProvider(raw) ? "std" : "custom";
        id = raw;
    }
    const configured = kind === "std" ? cfg.stdProviders[id] !== undefined : cfg.customProviders[id] !== undefined;
    const spec = kind === "std" ? snapshotProvider(id) : (specs[id] ?? null);
    if (kind === "custom" && !spec && !configured) {
        throw new Error(`provider ${raw} 不在 models.dev 收录里，也不在 providers.custom.yaml / model.yaml 里`);
    }
    return { kind, id, limited: kind === "custom" ? `custom:${id}` : id, cfg, specs, spec, configured };
}

/** 该 provider 的 spec 模型表（std = snapshot；custom = providers.custom.yaml） */
function specModels(loc: Located): Record<string, { name?: string; provider?: { npm?: string }; cost?: Cost }> {
    const m = loc.kind === "std" ? snapshotProvider(loc.id)?.models : loc.spec?.models;
    return m ?? {};
}

/** spec 里该模型的价（in/out 齐全才算"有价"：半个价算不上价，见 usage.ratesOf） */
function specCostOf(loc: Located, modelId: string): Cost | undefined {
    const raw = specModels(loc)[modelId]?.cost;
    if (!raw || (raw.input === undefined && raw.output === undefined)) return undefined;
    return structuredClone(raw);
}

/** 内置日历 id 清单（时段档 `calendar` 的合法取值；空表 = 任何日历引用都不命中） */
function calendarIds(): string[] {
    return Object.keys(calendars());
}

/** 具名时段表 id 清单（时段档 `window` 的合法取值；diy 扩展层 `models.dev.diy.json`） */
function windowIds(): string[] {
    return Object.keys(windowTable());
}

// ── llmConfig.costs ──

/**
 * 某 provider 的模型清单 + 生效价目 + 可写落点（agent 的发现入口）。
 * 未配置在 model.yaml 的 provider 也列（否则 agent 拿不到 model id 来填价）。
 */
export function providerCosts(home: string, ref: string): ProviderCostsView {
    const loc = locate(home, ref);
    const pv = registryView(home).providers.find((p) => p.limited === loc.limited);
    const overrides = pv?.config.models ?? {};
    const spec = specModels(loc);
    const npmOf = (id: string): string => spec[id]?.provider?.npm ?? loc.spec?.npm ?? "";

    const rows = pv
        ? pv.models.map((m) => ({ id: m.id, name: m.name, enabled: m.enabled, specMissing: m.specMissing }))
        : // 未配置：直接从 spec 投影（面不支持的模型不出现，与 registryView 一致）
          Object.entries(spec)
              .filter(([id]) => faceOfNpm(npmOf(id)) !== null)
              .map(([id, m]) => ({ id, name: m.name ?? id, enabled: true, specMissing: false }));

    const models = rows.map((r) => {
        const ov = overrides[r.id]?.cost;
        const sc = specCostOf(loc, r.id);
        const writable: CostTarget[] = [];
        if (loc.kind === "custom" && spec[r.id] !== undefined) writable.push("spec");
        if (loc.configured) writable.push("override");
        const source: CostSource = ov ? "override" : sc ? "spec" : "none";
        return {
            id: r.id,
            name: r.name,
            enabled: pv ? r.enabled : true,
            specMissing: r.specMissing,
            cost: ov ?? sc ?? null,
            costSource: source,
            writable,
        };
    });
    const tables = calendars();
    return {
        provider: loc.limited,
        kind: loc.kind,
        target: defaultTarget(loc.kind),
        configured: loc.configured,
        calendars: Object.entries(tables).map(([id, def]) => ({ id, label: calendarLabel(def, id) })),
        // 具名时段表（agent 填 `tier.data.window` 时要知道有哪些 id）；扩展层缺失/坏段的告警
        // 由加载器打到 stderr（`windowIssues()`），不混进这张下拉清单
        windows: windowChoices(),
        models,
    };
}

// ── 写路径 ──

/** cost 的宿主 + 落盘动作（内部用；`holder` 可直接读写 `cost` 键） */
interface WriteSlot {
    target: CostTarget;
    file: string;
    holder: { cost?: Cost };
    /** spec 基线价（override 首次写入时 seed；spec 落点不必 seed） */
    specCost: Cost | undefined;
    /** 清噪声 + 落盘（内存对象已改好） */
    commit: () => void;
}

function writeSlot(loc: Located, home: string, modelId: string, target: CostTarget): WriteSlot {
    if (target === "spec") {
        if (loc.kind !== "custom") {
            throw new Error(`${loc.limited} 是 models.dev 收录的 provider（价目在 snapshot 里）→ 请用 --target override 登记覆盖价`);
        }
        const sp = loc.specs[loc.id];
        if (!sp) throw new Error(`providers.custom.yaml 里没有 provider ${loc.id}（先在模型设置页加 custom provider）`);
        const m = sp.models[modelId];
        if (!m) {
            const ids = Object.keys(sp.models);
            throw new Error(
                `providers.custom.yaml 的 ${loc.id} 里没有模型 ${modelId}` +
                    (ids.length ? `（可用: ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? " …" : ""}）` : "") +
                    "。该模型不在 spec 里时用 --target override 登记",
            );
        }
        return {
            target,
            file: customSpecsFile(home),
            holder: m,
            specCost: specCostOf(loc, modelId),
            commit: () => {
                if (m.cost && isEmptyCost(m.cost)) delete m.cost;
                saveCustomSpecs(home, loc.specs);
            },
        };
    }

    const pc = (loc.kind === "std" ? loc.cfg.stdProviders : loc.cfg.customProviders)[loc.id];
    if (!pc) throw new Error(`model.yaml 里没有 provider ${loc.limited} 的配置（override 要有账号才能落盘）`);
    const models = (pc.models ??= {});
    const holder: { cost?: Cost } = (models[modelId] ??= {});
    return {
        target,
        file: modelConfigFile(home),
        holder,
        specCost: specCostOf(loc, modelId),
        commit: () => {
            if (holder.cost && isEmptyCost(holder.cost)) delete holder.cost;
            // 空条目 / 空 models 不留噪声（`models: {x: {}}` 是无效登记）
            if (holder.cost === undefined && Object.keys(holder).length === 0) delete models[modelId];
            if (Object.keys(models).length === 0) delete pc.models;
            saveModelConfig(home, loc.cfg);
        },
    };
}

// ── llmConfig.setCost ──

export interface SetCostArgs {
    provider: string;
    model: string;
    target: "auto" | CostTarget;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    baseLabel?: string;
    clear?: boolean;
    clearFields?: readonly CostClearField[];
}

/** 合并语义登记单价：只改给出的字段；`--clear` 删整块，`--clear-fields` 删指定字段 */
export function setModelCost(home: string, args: SetCostArgs): CostUpdateResult {
    const loc = locate(home, args.provider);
    const target: CostTarget = args.target === "auto" ? defaultTarget(loc.kind) : args.target;
    const slot = writeSlot(loc, home, args.model, target);

    if (args.clear === true) {
        delete slot.holder.cost;
        slot.commit();
        return receipt(loc, args.model, slot, false);
    }

    const patch: CostPatch = {
        input: args.input,
        output: args.output,
        cache_read: args.cacheRead,
        cache_write: args.cacheWrite,
        baseLabel: args.baseLabel,
        clearFields: args.clearFields,
    };
    const touched =
        [args.input, args.output, args.cacheRead, args.cacheWrite, args.baseLabel].some((v) => v !== undefined) ||
        (args.clearFields?.length ?? 0) > 0;
    if (!touched) {
        throw new Error("没有要改的字段：给 --input/--output/--cache-read/--cache-write/--base-label，或用 --clear 删整块");
    }

    const seeded = seed(slot);
    applyCostPatch(slot.holder.cost!, patch);
    slot.commit();
    return receipt(loc, args.model, slot, seeded);
}

// ── llmConfig.setTiers ──

export interface SetTiersArgs {
    provider: string;
    model: string;
    target: "auto" | CostTarget;
    tiers?: readonly TierWrite[];
    append?: boolean;
    drop?: number;
    clear?: boolean;
}

/** 登记时段档：`--tiers`（整体替换 / `--append` 追加）· `--drop n` · `--clear` 三选一 */
export function setModelTiers(home: string, args: SetTiersArgs): CostUpdateResult {
    const modes = [args.tiers !== undefined, args.drop !== undefined, args.clear === true].filter(Boolean).length;
    if (modes !== 1) {
        throw new Error("三种模式只能给一个：--tiers '[…]'（时段档数组）· --drop <n>（删第 n 条）· --clear（删光时段档）");
    }
    const loc = locate(home, args.provider);
    const target: CostTarget = args.target === "auto" ? defaultTarget(loc.kind) : args.target;
    const slot = writeSlot(loc, home, args.model, target);
    const seeded = seed(slot);
    const cost = slot.holder.cost!;

    if (args.clear === true) {
        if (clearUtcRangeTiers(cost) === 0) {
            throw new Error("该价目没有时段档可删（--clear 只删 utc-range 档，context 上下文档不动）");
        }
    } else if (args.drop !== undefined) {
        if (dropUtcRangeTier(cost, args.drop) === null) {
            throw new Error(`--drop ${args.drop} 越界：只有 ${utcRangeCount(cost)} 条时段档（0-based）`);
        }
    } else {
        setUtcRangeTiers(cost, args.tiers ?? [], args.append === true ? "append" : "replace");
    }
    slot.commit();
    return receipt(loc, args.model, slot, seeded);
}

/** 无 cost 时先建（override 首次写入以 spec 价为基线）；返回是否 seed 了 */
function seed(slot: WriteSlot): boolean {
    if (slot.holder.cost) return false;
    slot.holder.cost = slot.specCost ? structuredClone(slot.specCost) : {};
    return slot.specCost !== undefined;
}

// ── 回执 ──

/** 写后回执：落点价 + **生效**价（override > spec）+ 预警，让 agent 能自查「写了 / 生效 / 坑」 */
function receipt(loc: Located, modelId: string, slot: WriteSlot, seeded: boolean): CostUpdateResult {
    const map = loc.kind === "std" ? loc.cfg.stdProviders : loc.cfg.customProviders;
    const ov = map[loc.id]?.models?.[modelId]?.cost;
    const spec = specCostOf(loc, modelId);
    const here = slot.holder.cost;
    // `effective` 的口径恒为 **override > spec**，与 target 无关：写 spec 时若那边已有覆盖，
    // 真正生效的仍是覆盖价 —— 回执照 `here` 报会让人以为"我刚写的价生效了"（假回执）。
    const effective = ov ?? (slot.target === "spec" ? here : spec) ?? null;
    return {
        provider: loc.limited,
        kind: loc.kind,
        model: modelId,
        target: slot.target,
        file: slot.file,
        // cost = 该**落点**写后的样子（与 effective 不同 = 有回退，别只看 cost）
        cost: here ?? null,
        effective,
        tierCount: utcRangeCount(here),
        seededFromSpec: seeded,
        warnings: costWarnings(here ?? effective ?? undefined, calendarIds(), windowIds()),
    };
}

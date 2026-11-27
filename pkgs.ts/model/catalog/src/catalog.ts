// catalog.ts — 读配置 → 目录。唯一的 IO 都在这一个文件里（node:fs + js-yaml）。
//
// 数据流（谁也不覆盖谁，按 id 关联）：
//   spec 层  = providers.custom.yaml（custom provider 的模型规格）
//             + models.dev 快照（std provider 的模型规格，可选）
//   配置层   = model.yaml（accounts / filter / models 覆盖）
//   目录     = spec ⊕ override ＋ filter 判定
//
// ⚠️ 账号的 `data.value`（key）**只被 readAccountValue 读取**，目录与列表里永远只有名字。

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { isEmptyDocument } from "./errors.js";
import { CatalogError } from "./errors.js";
import type {
    CatalogOptions,
    ModelCatalogCapabilities,
    ModelCatalogCost,
    ModelCatalogEntry,
    ModelCatalogReasoning,
    ModelInputModality,
    ProviderAccounts,
} from './types.js';

// ── 宽松的原始形状（配置是人在编辑的 YAML：不认识就报错，缺字段给缺省） ──

interface RawAccount {
    readonly name?: string;
    readonly data?: { readonly value?: string };
}

interface RawFilter {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
}

interface RawCost {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
}

interface RawModelOverride {
    readonly name?: string;
    readonly limit?: { readonly context?: number; readonly output?: number };
    readonly cost?: RawCost;
    readonly reasoning_options?: readonly RawReasoningOption[];
    /** 能力覆盖（与 spec 层同名字段；缺省 = 不覆盖） */
    readonly attachment?: boolean;
    readonly reasoning?: boolean;
    readonly tool_call?: boolean;
    readonly structured_output?: boolean;
    readonly temperature?: boolean;
    readonly open_weights?: boolean;
    readonly release_date?: string;
    readonly last_updated?: string;
    readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
}

interface RawProviderConfig {
    readonly accounts?: readonly RawAccount[];
    readonly filter?: RawFilter;
    readonly models?: Readonly<Record<string, RawModelOverride>>;
}

interface RawModelYaml {
    readonly stdProviders?: Readonly<Record<string, RawProviderConfig>>;
    readonly customProviders?: Readonly<Record<string, RawProviderConfig>>;
}

/** models.dev 的 reasoning_options 一项：只有 type=effort 且带 values 才归一成候选档位 */
interface RawReasoningOption {
    readonly type?: string;
    readonly values?: readonly string[];
}

interface RawSpecModel {
    readonly name?: string;
    readonly limit?: { readonly context?: number; readonly output?: number };
    readonly cost?: RawCost;
    readonly reasoning_options?: readonly RawReasoningOption[];
    /** 能力标记（models.dev 同名字段；缺省 = 上游没声明，不等于「不支持」） */
    readonly attachment?: boolean;
    readonly reasoning?: boolean;
    readonly tool_call?: boolean;
    readonly structured_output?: boolean;
    readonly temperature?: boolean;
    readonly open_weights?: boolean;
    readonly release_date?: string;
    readonly last_updated?: string;
    readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
}

interface RawSpecProvider {
    readonly id?: string;
    readonly name?: string;
    readonly npm?: string;
    readonly api?: string;
    /** spec 声明的环境变量名（models.dev 的 `env`；填 key 时给人看） */
    readonly env?: readonly string[];
    readonly doc?: string;
    readonly models?: Readonly<Record<string, RawSpecModel>>;
}

/** 一个已解析的 provider（spec ⊕ config），内部用 */
interface ProviderInput {
    readonly providerId: string;
    readonly kind: 'std' | 'custom';
    readonly spec: RawSpecProvider | null;
    readonly config: RawProviderConfig;
}

// ── 公开 API ─────────────────────────────────────

/**
 * 读 `$DIY_HOME/model.yaml` + `$DIY_HOME/providers.custom.yaml`（+ 可选 models.dev 快照）
 * → 模型目录。**不含 key 值**，账号只有名字。
 */
export function loadCatalog(home: string, options?: CatalogOptions): ModelCatalogEntry[] {
    // 快照只解析一次（5 MB JSON）：providerInputs 与同名索引共用
    const snapshot = loadSnapshot(home, options);
    const inputs = providerInputs(home, options, snapshot);
    const sameName = sameNameSpecs(snapshot);
    const entries: ModelCatalogEntry[] = [];
    for (const input of inputs) {
        const baseURL = input.spec?.api;
        // 没有 baseURL 就发不出请求 —— 该 provider 的模型不进目录（配置层覆盖单独列模型也救不了）
        if (typeof baseURL !== 'string' || baseURL.trim() === '') continue;
        const npm = typeof input.spec?.npm === 'string' ? input.spec.npm : undefined;
        for (const entry of modelsOf(input, baseURL, npm, sameName)) entries.push(entry);
    }
    entries.sort(
        (a, b) =>
            a.providerId.localeCompare(b.providerId) ||
            (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY) ||
            a.modelId.localeCompare(b.modelId),
    );
    return entries;
}

/** 一个 provider 的只读摘要（provider 列表页用；不含任何 key） */
export interface ProviderSummary {
    readonly providerId: string;
    readonly kind: 'std' | 'custom';
    /** upstream baseURL；spec 没写 = 缺省（这类 provider 的模型不进目录） */
    readonly api?: string;
    /** ai-sdk 包名 */
    readonly npm?: string;
    /** 过滤后进入目录的模型数 */
    readonly modelCount: number;
}

/**
 * 列出 model.yaml 里配置的每个 provider（含没有 api 的 —— 它们不进目录，但仍要能看见 / 删掉）。
 * **不含 key**：账号另走 listAccountStates / readAccountValue。
 */
export function listProviders(home: string, options?: CatalogOptions): ProviderSummary[] {
    const out: ProviderSummary[] = [];
    for (const input of providerInputs(home, options)) {
        const api = typeof input.spec?.api === 'string' && input.spec.api.trim() !== '' ? input.spec.api : undefined;
        const npm = typeof input.spec?.npm === 'string' ? input.spec.npm : undefined;
        out.push({
            providerId: input.providerId,
            kind: input.kind,
            ...(api === undefined ? {} : { api }),
            ...(npm === undefined ? {} : { npm }),
            modelCount: api === undefined ? 0 : modelsOf(input, api, npm).length,
        });
    }
    return out;
}

/**
 * 列出 model.yaml 里每个 provider 的账号名（**只有名字**，按配置顺序）。
 * 未配置的 provider 不出现。
 */
export function listAccounts(home: string): ProviderAccounts[] {
    const config = loadModelYaml(home);
    const out: ProviderAccounts[] = [];
    for (const [kind, group] of [
        ['std', config.stdProviders ?? {}],
        ['custom', config.customProviders ?? {}],
    ] as const) {
        for (const [providerId, provider] of Object.entries(group)) {
            out.push({
                providerId,
                kind,
                names: accountNames(provider.accounts ?? []),
            });
        }
    }
    return out;
}

/** 一个账号的**状态**（不含 key）：名字 / 是否已填 / 字符数 */
export interface AccountState {
    readonly name: string;
    /** 有值就算「已填」（`$VAR` 未定义也算填了，只是展开不出来） */
    readonly configured: boolean;
    /** 字面量的字符数；值是 `$VAR` 引用时缺省（长度没有意义，也不该暴露原值） */
    readonly chars?: number;
    /** 值是不是 `$VAR` / `${VAR}` 环境引用 */
    readonly env: boolean;
}

/** 一个 provider 的账号状态清单（不含 key） */
export interface ProviderAccountStates {
    readonly providerId: string;
    readonly kind: 'std' | 'custom';
    readonly accounts: readonly AccountState[];
}

/**
 * 列出每个 provider 的账号**状态**（名字 / 是否已填 / 字符数）。
 *
 * 与 listAccounts 的区别：那个只要名字；这个给配置页判断「已设置 / 未设置」。
 * **依然不含 value** —— `chars` 是长度，不是值；值只经 `readAccountValue` 流出。
 */
export function listAccountStates(home: string): ProviderAccountStates[] {
    return accountStatesOf(loadModelYaml(home));
}

function accountStatesOf(config: RawModelYaml): ProviderAccountStates[] {
    const out: ProviderAccountStates[] = [];
    for (const [kind, group] of [
        ['std', config.stdProviders ?? {}],
        ['custom', config.customProviders ?? {}],
    ] as const) {
        for (const [providerId, provider] of Object.entries(group)) {
            out.push({ providerId, kind, accounts: accountStates(provider.accounts ?? []) });
        }
    }
    return out;
}

function accountStates(accounts: readonly RawAccount[]): AccountState[] {
    return accounts.map((account, index) => {
        const name = account.name ?? String(index);
        const value = account.data?.value ?? "";
        if (value.trim() === "") return { name, configured: false, env: false };
        if (/\$\{?[A-Za-z_]/.test(value)) return { name, configured: true, env: true };
        return { name, configured: true, env: false, chars: value.length };
    });
}

/** 目录里**可用**的一个模型 = 配置页模型表的一行 */
export interface AvailableModel {
    readonly id: string;
    readonly name: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly cost?: ModelCatalogCost;
    readonly reasoning?: ModelCatalogReasoning;
    /** 能力标记（视觉 / 工具 / 推理 / 附件 / 结构化输出）；缺省 = 上游没声明 */
    readonly capabilities?: ModelCatalogCapabilities;
    /** 过了 filter 就会真进目录；false = 在 spec 里但被关掉了 */
    readonly enabled: boolean;
}

/**
 * 目录里**可用**的一个 provider = 配置页左栏的一行。
 *
 * 与 `ProviderSummary` 的区别：那个只列 `model.yaml` 里**已配置**的（摘要用），
 * 这个把「目录里有、但还没接」的也列出来 —— 否则配置页只能编辑已有的那两家，
 * 「添加服务商」根本无从下手（候选清单本身就是空的）。
 */
export interface AvailableProvider {
    readonly providerId: string;
    readonly name: string;
    readonly kind: "std" | "custom";
    /** 在 `model.yaml` 里 —— false = 目录里可用但还没接（界面上「连接」就是给它建这一段） */
    readonly configured: boolean;
    /** 上游基址；没写 = 发不出请求（`loadCatalog` 会让这家整家缺席） */
    readonly api?: string;
    readonly npm?: string;
    /** spec 声明的环境变量名（models.dev 的 `env`）：填 key 时给人看 */
    readonly envKeys: readonly string[];
    readonly doc?: string;
    readonly accounts: readonly AccountState[];
    /** spec ⊕ 覆盖，**含被 filter 关掉的**（配置页要能把它们再打开） */
    readonly models: readonly AvailableModel[];
}

/**
 * 列出目录里**全部可用**的 provider（快照 ∪ custom spec ∪ `model.yaml`）。
 *
 * 三处 id 都要取并集：只看快照会漏掉自定义 provider；只看 `model.yaml` 就是
 * `listProviders`（只有已配置的，看不到候选）。id 落在 std 组还是 custom 组，
 * 以 `model.yaml` 的分组为准；没配置过的按来源归类（快照 → std、自定义 spec → custom）。
 */
export function availableProviders(home: string, options?: CatalogOptions): AvailableProvider[] {
    const config = loadModelYaml(home);
    const customSpecs = loadCustomSpecs(home);
    const snapshot = loadSnapshot(home, options);
    const stdIds = [...new Set([...Object.keys(snapshot ?? {}), ...Object.keys(config.stdProviders ?? {})])];
    const customIds = [...new Set([...Object.keys(customSpecs), ...Object.keys(config.customProviders ?? {})])];
    const out: AvailableProvider[] = [];
    for (const providerId of stdIds.sort()) {
        // snapshot 优先：同一家可能两份都有（自定义 spec 补的是快照缺的那几家）
        const spec = snapshot?.[providerId] ?? customSpecs[providerId] ?? null;
        out.push(availableOf(providerId, "std", spec, config.stdProviders?.[providerId]));
    }
    for (const providerId of customIds.sort()) {
        out.push(availableOf(providerId, "custom", customSpecs[providerId] ?? null, config.customProviders?.[providerId]));
    }
    return out;
}

function availableOf(
    providerId: string,
    kind: "std" | "custom",
    spec: RawSpecProvider | null,
    config: RawProviderConfig | undefined,
): AvailableProvider {
    const providerConfig = config ?? {};
    const filter = filterOf(providerConfig);
    const api = typeof spec?.api === "string" && spec.api.trim() !== "" ? spec.api : undefined;
    return {
        providerId,
        name: typeof spec?.name === "string" && spec.name.trim() !== "" ? spec.name : providerId,
        kind,
        configured: config !== undefined,
        ...(api === undefined ? {} : { api }),
        ...(typeof spec?.npm === "string" ? { npm: spec.npm } : {}),
        envKeys: spec?.env ?? [],
        ...(typeof spec?.doc === "string" ? { doc: spec.doc } : {}),
        accounts: accountStates(providerConfig.accounts ?? []),
        models: modelPairs(spec, providerConfig).map((pair) => ({
            ...modelViewOf(pair),
            enabled: isEnabled(pair.modelId, filter),
        })),
    };
}

/**
 * 取某个账号的 key（`$VAR` / `${VAR}` 按环境展开）。
 *
 * - `accountName` 缺省 ⇒ 挑**第一个展开后非空**的账号；都空就用第一个（会因空值报错）。
 * - key 值只经此函数流出；调用方负责不打印、不落日志。
 */
export function readAccountValue(
    home: string,
    providerId: string,
    accountName?: string,
    options?: CatalogOptions,
): string {
    const config = loadModelYaml(home);
    const group = findProviderGroup(config, providerId);
    if (group === null) {
        throw new CatalogError('catalog/unknown-provider', `model.yaml 里没有 provider "${providerId}"`, providerId);
    }
    const accounts = group.accounts ?? [];
    if (accounts.length === 0) {
        throw new CatalogError('catalog/account-empty', `provider "${providerId}" 没有任何账号`, providerId);
    }
    const env = options?.env ?? process.env;
    const named = accounts
        .map((account, index) => ({ name: account.name ?? String(index), value: account.data?.value ?? '' }))
        .filter((account) => accountName === undefined || account.name === accountName);
    if (named.length === 0) {
        throw new CatalogError(
            'catalog/unknown-account',
            `provider "${providerId}" 没有账号 "${accountName ?? ''}"（有：${accountNames(accounts).join(', ')}）`,
            providerId,
        );
    }
    let fallback = named[0]!;
    for (const account of named) {
        if (account.value.trim() === '') continue;
        const expanded = expandEnv(account.value, env, providerId);
        if (expanded !== null) return expanded;
        fallback = account;
    }
    if (fallback.value.trim() === '') {
        throw new CatalogError(
            'catalog/account-empty',
            `provider "${providerId}" 的账号 "${fallback.name}" 没有填 key`,
            providerId,
        );
    }
    return expandEnv(fallback.value, env, providerId, true) as string;
}

// ── 内部 ─────────────────────────────────────────

function providerInputs(
    home: string,
    options?: CatalogOptions,
    prefetched?: Record<string, RawSpecProvider> | null,
): ProviderInput[] {
    const config = loadModelYaml(home);
    const customSpecs = loadCustomSpecs(home);
    const snapshot = prefetched === undefined ? loadSnapshot(home, options) : prefetched;
    const out: ProviderInput[] = [];
    for (const [providerId, providerConfig] of Object.entries(config.stdProviders ?? {})) {
        out.push({ providerId, kind: 'std', spec: snapshot?.[providerId] ?? null, config: providerConfig });
    }
    for (const [providerId, providerConfig] of Object.entries(config.customProviders ?? {})) {
        out.push({ providerId, kind: 'custom', spec: customSpecs[providerId] ?? null, config: providerConfig });
    }
    return out;
}

/** 一个模型在 spec 与配置两边的原始片段（配置层可以盖掉名字 / 上限 / 价目） */
interface ModelPair {
    readonly modelId: string;
    readonly spec: RawSpecModel | undefined;
    readonly override: RawModelOverride | undefined;
}

/**
 * 同名模型索引：`modelId` → 快照里**某个 provider** 下同名、且真的说了模态的那一条。
 *
 * 为什么需要：网关 provider（`opencode-go` / `goat` 这类）代理的是**同名同源**的上游模型，
 * 但它们在 models.dev 里没有自己的条目（模型列表来自 stdProviders / providers.custom.yaml）。
 * 只按自己的条目判「输入模态」就会一律未知，而 `canSeeImages` 的判据是「没标 = 不收图」
 * —— 于是网关模型永远收不到图（2026-11-27 实测：`opencode-go/deepseek-v4.1-flash`
 * 与 `deepseek/deepseek-v4.1-flash` 是同一个模型，后者标了 text,image）。
 *
 * 约束：只借 **modelId 完全相同** 的；人写的配置依旧优先（借错了手写一句就盖回来）。
 */
function sameNameSpecs(snapshot: Record<string, RawSpecProvider> | null): ReadonlyMap<string, RawSpecModel> {
    const out = new Map<string, RawSpecModel>();
    // 扫**整份快照**，而不是只看配了账号的 provider：借能力位的场景恰恰是「网关 provider
    // 自己没条目」（`opencode-go` / `goat`），要借的那份在别的 provider 下面。
    for (const provider of Object.values(snapshot ?? {})) {
        for (const [modelId, spec] of Object.entries(provider.models ?? {})) {
            if (out.has(modelId)) continue;
            // 只收「说了模态」的条目：没说的借来也没信息，反而会挡住后面真正说了的那个
            if (spec?.modalities?.input === undefined && spec?.attachment === undefined) continue;
            out.set(modelId, spec);
        }
    }
    return out;
}

/** spec ⊕ 配置里出现过的**全部**模型 id（含被 filter 关掉的） */
function modelPairs(spec: RawSpecProvider | null, config: RawProviderConfig): ModelPair[] {
    const specModels = spec?.models ?? {};
    const overrides = config.models ?? {};
    const ids = Object.keys(specModels);
    for (const id of Object.keys(overrides)) if (!ids.includes(id)) ids.push(id);
    return ids.map((modelId) => ({ modelId, spec: specModels[modelId], override: overrides[modelId] }));
}

interface Filter {
    readonly include: Set<string> | null;
    readonly exclude: Set<string>;
}

function filterOf(config: RawProviderConfig): Filter {
    const filter = config.filter ?? {};
    return { include: nonEmpty(filter.include), exclude: new Set(filter.exclude ?? []) };
}

/** 过了 filter = 会进目录。`include` 非空时**只**认列出的那几个（与 `modelsOf` 同一条规则） */
function isEnabled(modelId: string, filter: Filter): boolean {
    if (filter.exclude.has(modelId)) return false;
    if (filter.include !== null && !filter.include.has(modelId)) return false;
    return true;
}

/**
 * 把 models.dev 的 reasoning_options 归一成 UI 契约：只有 type=effort 且带非空 values
 * 才算「可选 effort」，档位原样透传、第一档当默认。toggle / budget_tokens / 空 / 无 → 缺省。
 * override 层若声明了 reasoning_options 就覆盖 spec 层（与 limit/cost 同一覆盖语义）。
 */
function reasoningOf(pair: ModelPair): ModelCatalogReasoning | undefined {
    const raw = pair.override?.reasoning_options ?? pair.spec?.reasoning_options;
    if (raw === undefined) return undefined;
    for (const option of raw) {
        if (option.type !== "effort") continue;
        const values = (option.values ?? []).filter((value) => typeof value === "string" && value !== "");
        if (values.length === 0) continue;
        return { efforts: values, defaultEffort: values[0]! };
    }
    return undefined;
}

/**
 * 能力标记：models.dev 的布尔字段原样搬；vision 从 `modalities.input` 推。
 * 五项全没声明 → 缺省（未知），**别把 undefined 变 false 冒充「不支持」**。
 * override 层可覆盖 spec 层（与 limit / cost 同一语义）。
 */
function capabilitiesOf(pair: ModelPair): ModelCatalogCapabilities | undefined {
    const spec = pair.spec;
    const override = pair.override;
    if (spec === undefined && override === undefined) return undefined;
    const pick = (
        key: "attachment" | "reasoning" | "tool_call" | "structured_output" | "temperature" | "open_weights",
    ): boolean | undefined => {
        const raw = override?.[key] ?? spec?.[key];
        return typeof raw === "boolean" ? raw : undefined;
    };
    const str = (a: string | undefined, b: string | undefined): string | undefined =>
        typeof a === "string" && a !== "" ? a : typeof b === "string" && b !== "" ? b : undefined;
    const inputs = override?.modalities?.input ?? spec?.modalities?.input;
    const outputs = override?.modalities?.output ?? spec?.modalities?.output;
    const vision = Array.isArray(inputs) ? inputs.includes("image") : undefined;
    const values = {
        vision,
        toolCall: pick("tool_call"),
        reasoning: pick("reasoning"),
        attachment: pick("attachment"),
        structuredOutput: pick("structured_output"),
        temperature: pick("temperature"),
        openWeights: pick("open_weights"),
        inputs: Array.isArray(inputs) ? inputs : undefined,
        outputs: Array.isArray(outputs) ? outputs : undefined,
        releaseDate: str(override?.release_date, spec?.release_date),
        lastUpdated: str(override?.last_updated, spec?.last_updated),
    };
    // 全未知 ⇒ 不产 capabilities（区别于「全是 false / 空数组」）
    if (Object.values(values).every((value) => value === undefined)) return undefined;
    return {
        vision: values.vision ?? false,
        toolCall: values.toolCall ?? false,
        reasoning: values.reasoning ?? false,
        attachment: values.attachment ?? false,
        structuredOutput: values.structuredOutput ?? false,
        temperature: values.temperature ?? false,
        openWeights: values.openWeights ?? false,
        inputs: values.inputs ?? [],
        outputs: values.outputs ?? [],
        ...(values.releaseDate === undefined ? {} : { releaseDate: values.releaseDate }),
        ...(values.lastUpdated === undefined ? {} : { lastUpdated: values.lastUpdated }),
    };
}

function modelViewOf(pair: ModelPair): Omit<AvailableModel, "enabled"> {
    const contextWindow = pair.override?.limit?.context ?? pair.spec?.limit?.context;
    const maxOutput = pair.override?.limit?.output ?? pair.spec?.limit?.output;
    const cost = pair.override?.cost !== undefined ? costOf(pair.override.cost) : costOf(pair.spec?.cost);
    const reasoning = reasoningOf(pair);
    const capabilities = capabilitiesOf(pair);
    return {
        id: pair.modelId,
        name: pair.override?.name ?? pair.spec?.name ?? pair.modelId,
        ...(typeof contextWindow === "number" ? { contextWindow } : {}),
        ...(typeof maxOutput === "number" ? { maxOutputTokens: maxOutput } : {}),
        ...(cost === undefined ? {} : { cost }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(capabilities === undefined ? {} : { capabilities }),
    };
}

function modelsOf(
    input: ProviderInput,
    baseURL: string,
    npm: string | undefined,
    sameName: ReadonlyMap<string, RawSpecModel> = new Map(),
): ModelCatalogEntry[] {
    const filter = filterOf(input.config);
    const out: ModelCatalogEntry[] = [];
    for (const pair of modelPairs(input.spec, input.config)) {
        if (!isEnabled(pair.modelId, filter)) continue;
        const view = modelViewOf(pair);
        // 输入模态：自身声明优先，缺了借同名模型。
        //
        // ⚠️ 这一行修的是一个**静默 bug**（2026-11-27 用户实测报的）：`inputOf` 早就写好了
        // 完整的优先顺序，但**没有任何地方调用它** ⇒ `entry.input` 永远是 undefined ⇒
        // `canSeeImages()` 一律 false ⇒ 视觉守卫把所有图都当成「模型不收图」拦掉
        // （连 `deepseek-v4-flash-vision-exp` 也拦）。类型检查发现不了这种「函数没人用」。
        const modalities = inputOf(pair.override, pair.spec, sameName.get(pair.modelId));
        out.push({
            providerId: input.providerId,
            modelId: pair.modelId,
            name: view.name,
            baseURL,
            ...(npm === undefined ? {} : { npm }),
            ...(view.contextWindow === undefined ? {} : { contextWindow: view.contextWindow }),
            ...(view.maxOutputTokens === undefined ? {} : { maxOutputTokens: view.maxOutputTokens }),
            ...(view.cost === undefined ? {} : { cost: view.cost }),
            ...(view.reasoning === undefined ? {} : { reasoning: view.reasoning }),
            ...(view.capabilities === undefined ? {} : { capabilities: view.capabilities }),
            ...(modalities === undefined ? {} : { input: modalities }),
        });
    }
    return out;
}

/** 认识的输入模态（其余字符串丢掉，不报错：快照是外部数据，多一种模态不该让整个目录炸） */
const INPUT_MODALITIES: readonly ModelInputModality[] = ['text', 'image', 'audio', 'video', 'pdf'];

/**
 * 一个模型的输入模态 —— 两份来源按优先顺序：
 *   ① 配置层手写（`model.yaml` / `providers.custom.yaml` 的 `models.<id>`）—— 人能改的最终说法
 *   ② spec 层的 `modalities.input`
 *   ③ spec 层的 `attachment`（models.dev 的简写：true 就收图）
 *   ④ 都没有 ⇒ **undefined（不知道）**，不是「不收」
 */
function inputOf(
    override: RawModelOverride | undefined,
    spec: RawSpecModel | undefined,
    fallback?: RawSpecModel,
): readonly ModelInputModality[] | undefined {
    // 顺序：人写的（override）→ 该 provider 的 spec → **同名模型**（fallback）
    const declared = override?.modalities?.input ?? spec?.modalities?.input ?? fallback?.modalities?.input;
    if (declared !== undefined) return normalizeModalities(declared);
    const attachment = override?.attachment ?? spec?.attachment ?? fallback?.attachment;
    if (attachment === undefined) return undefined;
    return attachment ? ['text', 'image'] : ['text'];
}

function normalizeModalities(raw: readonly string[]): readonly ModelInputModality[] {
    const out = raw.filter((item): item is ModelInputModality => INPUT_MODALITIES.includes(item as ModelInputModality));
    // 上游偶尔只写 ["image"]：任何模型都收文字，补齐后再返回（否则 UI 会以为它不吃人类的话）
    return out.includes('text') ? out : ['text', ...out];
}

/**
 * 生效输出上限：模型给了**正值**就用，否则回退 `fallback`。**保证返回 >= 1**。
 *
 * 为什么必须有这层：`streamText({ maxOutputTokens })` 传 0 / 负数会被 SDK 直接拒
 * （"maxOutputTokens must be >= 1"，##184 实测）。而真实数据里"上限未知"是常态 ——
 * models.dev 有时只给 context_length 不给 limit.output，`providers.custom.yaml` 也可能漏写。
 * 那时绝不能把 undefined 顺手当 0 发下去（静默 500 或直接拒），必须回退到场景缺省。
 *
 * 语义区分（三者不同，别混）：
 *   undefined  = 模型没声明上限
 *   0 / 负数   = 上游给了个非法值（当"没声明"处理，回退）
 *   >= 1       = 正常
 */
export function effectiveMaxOutputTokens(
    entry: Pick<ModelCatalogEntry, 'maxOutputTokens'> | undefined,
    fallback: number,
): number {
    const n = entry?.maxOutputTokens;
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : Math.floor(Math.max(1, fallback));
}

function costOf(raw: RawCost | undefined): ModelCatalogCost | undefined {
    if (raw === undefined || typeof raw.input !== 'number' || typeof raw.output !== 'number') return undefined;
    return {
        input: raw.input,
        output: raw.output,
        ...(typeof raw.cache_read === 'number' ? { cacheRead: raw.cache_read } : {}),
        ...(typeof raw.cache_write === 'number' ? { cacheWrite: raw.cache_write } : {}),
    };
}

function nonEmpty(values: readonly string[] | undefined): Set<string> | null {
    const set = new Set(values ?? []);
    return set.size === 0 ? null : set;
}

function accountNames(accounts: readonly RawAccount[]): string[] {
    return accounts.map((account, index) => account.name ?? String(index));
}

function findProviderGroup(
    config: RawModelYaml,
    providerId: string,
): { readonly accounts?: readonly RawAccount[] } | null {
    return config.stdProviders?.[providerId] ?? config.customProviders?.[providerId] ?? null;
}

function loadModelYaml(home: string): RawModelYaml {
    const path = join(home, 'model.yaml');
    const raw = readYaml(path);
    if (raw === null) return {};
    if (!isRecord(raw)) throw new CatalogError('catalog/invalid-config', `${path} 顶层必须是映射`, path);
    return raw as RawModelYaml;
}

function loadCustomSpecs(home: string): Record<string, RawSpecProvider> {
    const path = join(home, 'providers.custom.yaml');
    const raw = readYaml(path);
    if (raw === null) return {};
    if (!isRecord(raw)) throw new CatalogError('catalog/invalid-config', `${path} 顶层必须是映射`, path);
    return raw as Record<string, RawSpecProvider>;
}

/**
 * 目录快照（models.dev 的 std provider 规格）的缺省位置。
 *
 * 单独导出：调用方要能回答「我这儿到底缺没缺这份」——「缺」是一个要显示出来的状态，
 * 不是静默回落到别的目录。
 */
export function snapshotPath(home: string): string {
    return join(home, "data", "models.dev.json");
}

/**
 * 快照（std provider 的 spec）：显式路径 > `$DIY_HOME/data/`。
 *
 * 曾经还有第三档：「四级上跳读**本仓** `apps/diy-app/src/main/data/models.dev.json`」。删于
 * 2026-11-24：那是 diy-app 的产物快照（199 家 / 11-03），发布形态下这个相对路径指向不存在的
 * 位置、monorepo 下又让另一个 app 的旧数据给本 app 的目录定义规格 —— 两种形态都不对。
 * 现在**没有快照就是没有**：std provider 全部缺席，调用方据 `snapshotPath()` 报「缺快照」。
 */
function loadSnapshot(home: string, options?: CatalogOptions): Record<string, RawSpecProvider> | null {
    const candidates = [options?.snapshotPath, snapshotPath(home)];
    for (const candidate of candidates) {
        if (candidate === undefined || !existsSync(candidate)) continue;
        const raw = readYaml(candidate);
        if (raw === null) continue;
        if (!isRecord(raw)) throw new CatalogError('catalog/invalid-config', `${candidate} 顶层必须是映射`, candidate);
        return raw as Record<string, RawSpecProvider>;
    }
    return null;
}

/**
 * YAML / JSON 解析缓存（按 **路径 + mtime + 大小** 判新旧）。
 *
 * 为什么必须有：`models.dev.json` 是 4.6 MB / 199 个 provider，JSON.parse 一次 ~75 ms；
 * 而 `loadCatalog()` 每个快照要被调 2~3 次（选模型 / 窗口 / 价目各一趟），实测切一次 bot
 * 光这里就 400+ ms（##526）。文件没变就没必要重解析 —— mtime 变了自动失效，
 * 所以「改 model.yaml → 界面立刻变」的语义不变。
 *
 * 缓存的是**解析结果**（不可变只读对象）；调用方不许改它。
 */
const yamlCache = new Map<string, { stamp: string; value: unknown }>();

function readYaml(path: string): unknown {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    const stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    const hit = yamlCache.get(path);
    if (hit !== undefined && hit.stamp === stamp) return hit.value;
    try {
        const value = loadYaml(readFileSync(path, 'utf-8'));
        yamlCache.set(path, { stamp, value });
        return value;
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // 「空文档」不是坏配置：0 字节、只有空行、只有注释的 YAML 都是合法的空文档，
        // 但 js-yaml 一律抛 `expected a document, but the input is empty`。当成 `{}` ——
        // 否则一个 `touch` 出来的空 model.yaml 会让读侧报「解析失败」，界面上就是
        // 「目录空着 + 一条读不懂的错误」，而配置页正要去填它。
        if (isEmptyDocument(message)) return {};
        throw new CatalogError("catalog/invalid-config", `${path} 解析失败：${message}`, path);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `$VAR` / `${VAR}` 展开（只认环境变量；未定义 = fail-fast）。`null` = 展开失败 */
function expandEnv(
    value: string,
    env: Readonly<Record<string, string | undefined>>,
    providerId: string,
    throwOnError = false,
): string | null {
    if (!value.includes('$')) return value;
    const missing: string[] = [];
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
        const name: string = braced ?? bare;
        const resolved = env[name];
        if (resolved === undefined) {
            missing.push(name);
            return '';
        }
        return resolved;
    });
    if (missing.length > 0) {
        if (!throwOnError) return null;
        throw new CatalogError(
            'catalog/account-unresolved',
            `provider "${providerId}" 的 key 引用了未定义的环境变量 ${missing.map((n) => `$${n}`).join(', ')}`,
            providerId,
        );
    }
    return out;
}

/**
 * 这个模型能不能收图（吃 image part）。
 *
 * 判据故意是「明确写了 image 才算」：`input` 缺省 = **数据里没有这条信息**，
 * 而当「不收」处理 —— 往一个不收图的上游塞 image part 换回来的是 400，
 * 与其赌一把不如先按文字发（UI 该在贴图前就拿这个判据挡住，见 vision-guard）。
 */
export function canSeeImages(entry: Pick<ModelCatalogEntry, 'input'> | undefined): boolean {
    return entry?.input?.includes('image') === true;
}

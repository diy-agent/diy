// catalog.ts — 读配置 → 目录。唯一的 IO 都在这一个文件里（node:fs + js-yaml）。
//
// 数据流（谁也不覆盖谁，按 id 关联）：
//   spec 层  = providers.custom.yaml（custom provider 的模型规格）
//             + models.dev 快照（std provider 的模型规格，可选）
//   配置层   = model.yaml（accounts / filter / models 覆盖）
//   目录     = spec ⊕ override ＋ filter 判定
//
// ⚠️ 账号的 `data.value`（key）**只被 readAccountValue 读取**，目录与列表里永远只有名字。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { CatalogError } from "./errors.js";
import type {
    CatalogOptions,
    ModelCatalogCost,
    ModelCatalogEntry,
    ProviderAccounts,
} from "./types.js";

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
    readonly limit?: { readonly context?: number };
    readonly cost?: RawCost;
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

interface RawSpecModel {
    readonly name?: string;
    readonly limit?: { readonly context?: number };
    readonly cost?: RawCost;
}

interface RawSpecProvider {
    readonly id?: string;
    readonly npm?: string;
    readonly api?: string;
    readonly models?: Readonly<Record<string, RawSpecModel>>;
}

/** 一个已解析的 provider（spec ⊕ config），内部用 */
interface ProviderInput {
    readonly providerId: string;
    readonly kind: "std" | "custom";
    readonly spec: RawSpecProvider | null;
    readonly config: RawProviderConfig;
}

// ── 公开 API ─────────────────────────────────────

/**
 * 读 `$DIY_HOME/model.yaml` + `$DIY_HOME/providers.custom.yaml`（+ 可选 models.dev 快照）
 * → 模型目录。**不含 key 值**，账号只有名字。
 */
export function loadCatalog(home: string, options?: CatalogOptions): ModelCatalogEntry[] {
    const inputs = providerInputs(home, options);
    const entries: ModelCatalogEntry[] = [];
    for (const input of inputs) {
        const baseURL = input.spec?.api;
        // 没有 baseURL 就发不出请求 —— 该 provider 的模型不进目录（配置层覆盖单独列模型也救不了）
        if (typeof baseURL !== "string" || baseURL.trim() === "") continue;
        const npm = typeof input.spec?.npm === "string" ? input.spec.npm : undefined;
        for (const entry of modelsOf(input, baseURL, npm)) entries.push(entry);
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
    readonly kind: "std" | "custom";
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
        const api = typeof input.spec?.api === "string" && input.spec.api.trim() !== "" ? input.spec.api : undefined;
        const npm = typeof input.spec?.npm === "string" ? input.spec.npm : undefined;
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
        ["std", config.stdProviders ?? {}],
        ["custom", config.customProviders ?? {}],
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
    readonly kind: "std" | "custom";
    readonly accounts: readonly AccountState[];
}

/**
 * 列出每个 provider 的账号**状态**（名字 / 是否已填 / 字符数）。
 *
 * 与 listAccounts 的区别：那个只要名字；这个给配置页判断「已设置 / 未设置」。
 * **依然不含 value** —— `chars` 是长度，不是值；值只经 `readAccountValue` 流出。
 */
export function listAccountStates(home: string): ProviderAccountStates[] {
    const config = loadModelYaml(home);
    const out: ProviderAccountStates[] = [];
    for (const [kind, group] of [
        ["std", config.stdProviders ?? {}],
        ["custom", config.customProviders ?? {}],
    ] as const) {
        for (const [providerId, provider] of Object.entries(group)) {
            out.push({
                providerId,
                kind,
                accounts: (provider.accounts ?? []).map((account, index) => {
                    const name = account.name ?? String(index);
                    const value = account.data?.value ?? "";
                    if (value.trim() === "") return { name, configured: false, env: false };
                    if (/\$\{?[A-Za-z_]/.test(value)) return { name, configured: true, env: true };
                    return { name, configured: true, env: false, chars: value.length };
                }),
            });
        }
    }
    return out;
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
        throw new CatalogError("catalog/unknown-provider", `model.yaml 里没有 provider "${providerId}"`, providerId);
    }
    const accounts = group.accounts ?? [];
    if (accounts.length === 0) {
        throw new CatalogError("catalog/account-empty", `provider "${providerId}" 没有任何账号`, providerId);
    }
    const env = options?.env ?? process.env;
    const named = accounts
        .map((account, index) => ({ name: account.name ?? String(index), value: account.data?.value ?? "" }))
        .filter((account) => accountName === undefined || account.name === accountName);
    if (named.length === 0) {
        throw new CatalogError(
            "catalog/unknown-account",
            `provider "${providerId}" 没有账号 "${accountName ?? ""}"（有：${accountNames(accounts).join(", ")}）`,
            providerId,
        );
    }
    let fallback = named[0]!;
    for (const account of named) {
        if (account.value.trim() === "") continue;
        const expanded = expandEnv(account.value, env, providerId);
        if (expanded !== null) return expanded;
        fallback = account;
    }
    if (fallback.value.trim() === "") {
        throw new CatalogError(
            "catalog/account-empty",
            `provider "${providerId}" 的账号 "${fallback.name}" 没有填 key`,
            providerId,
        );
    }
    return expandEnv(fallback.value, env, providerId, true) as string;
}

// ── 内部 ─────────────────────────────────────────

function providerInputs(home: string, options?: CatalogOptions): ProviderInput[] {
    const config = loadModelYaml(home);
    const customSpecs = loadCustomSpecs(home);
    const snapshot = loadSnapshot(home, options);
    const out: ProviderInput[] = [];
    for (const [providerId, providerConfig] of Object.entries(config.stdProviders ?? {})) {
        out.push({ providerId, kind: "std", spec: snapshot?.[providerId] ?? null, config: providerConfig });
    }
    for (const [providerId, providerConfig] of Object.entries(config.customProviders ?? {})) {
        out.push({ providerId, kind: "custom", spec: customSpecs[providerId] ?? null, config: providerConfig });
    }
    return out;
}

function modelsOf(input: ProviderInput, baseURL: string, npm: string | undefined): ModelCatalogEntry[] {
    const specModels = input.spec?.models ?? {};
    const overrides = input.config.models ?? {};
    const filter = input.config.filter ?? {};
    const include = nonEmpty(filter.include);
    const exclude = new Set(filter.exclude ?? []);
    const ids = Object.keys(specModels);
    for (const id of Object.keys(overrides)) if (!ids.includes(id)) ids.push(id);

    const out: ModelCatalogEntry[] = [];
    for (const modelId of ids) {
        if (exclude.has(modelId)) continue;
        if (include !== null && !include.has(modelId)) continue;
        const spec = specModels[modelId];
        const override = overrides[modelId];
        const contextWindow = override?.limit?.context ?? spec?.limit?.context;
        const cost = override?.cost !== undefined ? costOf(override.cost) : costOf(spec?.cost);
        out.push({
            providerId: input.providerId,
            modelId,
            name: override?.name ?? spec?.name ?? modelId,
            baseURL,
            ...(npm === undefined ? {} : { npm }),
            ...(typeof contextWindow === "number" ? { contextWindow } : {}),
            ...(cost === undefined ? {} : { cost }),
        });
    }
    return out;
}

function costOf(raw: RawCost | undefined): ModelCatalogCost | undefined {
    if (raw === undefined || typeof raw.input !== "number" || typeof raw.output !== "number") return undefined;
    return {
        input: raw.input,
        output: raw.output,
        ...(typeof raw.cache_read === "number" ? { cacheRead: raw.cache_read } : {}),
        ...(typeof raw.cache_write === "number" ? { cacheWrite: raw.cache_write } : {}),
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
    const path = join(home, "model.yaml");
    const raw = readYaml(path);
    if (raw === null) return {};
    if (!isRecord(raw)) throw new CatalogError("catalog/invalid-config", `${path} 顶层必须是映射`, path);
    return raw as RawModelYaml;
}

function loadCustomSpecs(home: string): Record<string, RawSpecProvider> {
    const path = join(home, "providers.custom.yaml");
    const raw = readYaml(path);
    if (raw === null) return {};
    if (!isRecord(raw)) throw new CatalogError("catalog/invalid-config", `${path} 顶层必须是映射`, path);
    return raw as Record<string, RawSpecProvider>;
}

/** 快照（std provider 的 spec）：显式路径 > `$DIY_HOME/data/` > 本仓 diy-app 的内置产物 */
function loadSnapshot(home: string, options?: CatalogOptions): Record<string, RawSpecProvider> | null {
    const candidates = [
        options?.snapshotPath,
        join(home, "data", "models.dev.json"),
        resolve(dirname(fileURLToPath(import.meta.url)), "../../diy-app/src/main/data/models.dev.json"),
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || !existsSync(candidate)) continue;
        const raw = readYaml(candidate);
        if (raw === null) continue;
        if (!isRecord(raw)) throw new CatalogError("catalog/invalid-config", `${candidate} 顶层必须是映射`, candidate);
        return raw as Record<string, RawSpecProvider>;
    }
    return null;
}

function readYaml(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
        return loadYaml(readFileSync(path, "utf-8"));
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new CatalogError("catalog/invalid-config", `${path} 解析失败：${message}`, path);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `$VAR` / `${VAR}` 展开（只认环境变量；未定义 = fail-fast）。`null` = 展开失败 */
function expandEnv(
    value: string,
    env: Readonly<Record<string, string | undefined>>,
    providerId: string,
    throwOnError = false,
): string | null {
    if (!value.includes("$")) return value;
    const missing: string[] = [];
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
        const name: string = braced ?? bare;
        const resolved = env[name];
        if (resolved === undefined) {
            missing.push(name);
            return "";
        }
        return resolved;
    });
    if (missing.length > 0) {
        if (!throwOnError) return null;
        throw new CatalogError(
            "catalog/account-unresolved",
            `provider "${providerId}" 的 key 引用了未定义的环境变量 ${missing.map((n) => `$${n}`).join(", ")}`,
            providerId,
        );
    }
    return out;
}

// write.ts — 配置的**写侧**：provider / 账号 / 默认模型落回 `$DIY_HOME/*.yaml`。
//
// 与 catalog.ts 的分工：那边只读投影，这边只改文件；两边共用同一份原始形状口径
// （配置是人在编辑的 YAML，缺字段给缺省，结构非法 fail-fast）。
//
// 硬边界（##467）：
//   · **key 只进不出**：`saveAccount` 只接受 value、只返回 `{ chars }`，绝不回读原值；
//     本文件里没有任何把 key 写进返回值 / 错误消息的路径。
//   · 所有写入走 `writeFileAtomic`（同目录 tmp → rename），失败不留半截文件、目标逐字不变。
//   · 只改目标字段，**不重排 / 不丢**用户已有的其它字段（整份 dump 但原对象先读后改）。
//   · 不含 DOM、不含 Electron —— 主进程与单测共用。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { writeFileAtomic } from './atomic.js';
import { CatalogError } from './errors.js';
import type { ModelCatalogCost } from './types.js';

type Rec = Record<string, unknown>;

/** 一个模型的覆盖字段（写到 model.yaml 的 `<group>.<providerId>.models.<modelId>`） */
export interface ProviderModelPatch {
    readonly name?: string;
    /** 上下文窗口（tokens）→ `limit.context` */
    readonly contextWindow?: number;
    /** 价目 → `cost.{input,output,cache_read,cache_write}` */
    readonly cost?: ModelCatalogCost;
}

/** `saveProvider` 的入参：spec 进 providers.custom.yaml，models 覆盖进 model.yaml */
export interface SaveProviderInput {
    readonly providerId: string;
    /** 缺省：已在 model.yaml 里就沿用原分组，否则 custom */
    readonly kind?: 'std' | 'custom';
    /** 自定义 provider 的 spec（只对 custom 有效） */
    readonly spec?: {
        readonly id?: string;
        readonly npm?: string;
        readonly api?: string;
    };
    /** 模型覆盖（合并；不传 = 不动已有覆盖） */
    readonly models?: Readonly<Record<string, ProviderModelPatch>>;
    /** 要删掉的模型覆盖（只删 model.yaml 的覆盖；spec 里有的模型仍在目录里） */
    readonly removeModels?: readonly string[];
}

/** `saveAccount` 的入参：value 是唯一会流进来的 key */
export interface SaveAccountInput {
    readonly providerId: string;
    readonly name: string;
    readonly value: string;
}

/** `saveAccount` 的返回值 —— **只有长度**，没有 value */
export interface SavedAccount {
    readonly providerId: string;
    readonly name: string;
    readonly chars: number;
}

// ── 公开 API ─────────────────────────────────────

/** 新增 / 更新一个 provider：spec 写 providers.custom.yaml，模型覆盖写 model.yaml */
export function saveProvider(home: string, input: SaveProviderInput): void {
    const providerId = requireProviderId(input.providerId);
    const modelPath = join(home, 'model.yaml');
    const modelDoc = readDoc(modelPath);
    const kind = input.kind ?? existingKind(modelDoc, providerId) ?? 'custom';

    if (input.spec !== undefined) {
        if (kind !== 'custom') {
            throw new CatalogError(
                'catalog/invalid-options',
                `provider "${providerId}" 是 std 分组：spec（api/npm）只对 custom provider 有效`,
                providerId,
            );
        }
        const customPath = join(home, 'providers.custom.yaml');
        const customDoc = readDoc(customPath);
        const spec = asRecord(customDoc[providerId]) ?? {};
        spec['id'] = input.spec.id ?? providerId;
        if (input.spec.npm !== undefined) spec['npm'] = input.spec.npm;
        if (input.spec.api !== undefined) spec['api'] = input.spec.api;
        customDoc[providerId] = spec;
        writeDoc(customPath, customDoc);
    }

    const group = ensureGroup(modelDoc, kind);
    const provider = asRecord(group[providerId]) ?? {};
    if (input.models !== undefined && Object.keys(input.models).length > 0) {
        const models = asRecord(provider['models']) ?? {};
        for (const [modelId, patch] of Object.entries(input.models)) {
            if (modelId.trim() === '') {
                throw new CatalogError('catalog/invalid-options', '模型 id 不能为空', providerId);
            }
            models[modelId] = mergeModelPatch(asRecord(models[modelId]) ?? {}, patch);
        }
        provider['models'] = models;
    }
    if (input.removeModels !== undefined && input.removeModels.length > 0) {
        const models = asRecord(provider['models']);
        if (models !== null) {
            for (const modelId of input.removeModels) delete models[modelId];
            provider['models'] = models;
        }
    }
    group[providerId] = provider;
    writeDoc(modelPath, modelDoc);
}

/** 从 model.yaml 与 providers.custom.yaml 里一起删掉一个 provider */
export function removeProvider(home: string, providerId: string): void {
    const id = requireProviderId(providerId);
    const modelPath = join(home, 'model.yaml');
    const modelDoc = readDoc(modelPath);
    let touched = false;
    for (const groupKey of ['stdProviders', 'customProviders'] as const) {
        const group = asRecord(modelDoc[groupKey]);
        if (group !== null && id in group) {
            delete group[id];
            touched = true;
        }
    }
    if (touched) writeDoc(modelPath, modelDoc);

    const customPath = join(home, 'providers.custom.yaml');
    const customDoc = readDoc(customPath);
    if (id in customDoc) {
        delete customDoc[id];
        writeDoc(customPath, customDoc);
    }

    if (!touched && !existsSync(customPath)) {
        throw new CatalogError('catalog/unknown-provider', `没有 provider "${id}"`, id);
    }
}

/**
 * 设置 / 更换一个账号的 key。
 *
 * 返回值**只有长度**：`{ providerId, name, chars }`。原值不落日志、不进返回值，
 * 调用方（UI / IPC）拿不到明文，就没有回显的可能。
 */
export function saveAccount(home: string, input: SaveAccountInput): SavedAccount {
    const providerId = requireProviderId(input.providerId);
    const name = input.name.trim();
    if (name === '') {
        throw new CatalogError('catalog/invalid-options', '账号名不能为空', providerId);
    }
    if (typeof input.value !== 'string' || input.value.trim() === '') {
        throw new CatalogError('catalog/invalid-options', `provider "${providerId}" 的 key 不能为空`, providerId);
    }

    const path = join(home, 'model.yaml');
    const doc = readDoc(path);
    const kind = existingKind(doc, providerId);
    if (kind === null) {
        throw new CatalogError('catalog/unknown-provider', `model.yaml 里没有 provider "${providerId}"`, providerId);
    }
    const group = ensureGroup(doc, kind);
    const provider = asRecord(group[providerId]) ?? {};
    const accounts = Array.isArray(provider['accounts']) ? (provider['accounts'] as unknown[]) : [];
    const next = accounts.map((item) => asRecord(item) ?? {});
    const index = next.findIndex((account, i) => accountNameOf(account, i) === name);
    if (index >= 0) {
        const account = next[index]!;
        account['type'] = typeof account['type'] === 'string' ? account['type'] : 'apiKey';
        const data = asRecord(account['data']) ?? {};
        data['value'] = input.value;
        account['data'] = data;
        next[index] = account;
    } else {
        next.push({ type: 'apiKey', name, data: { value: input.value } });
    }
    provider['accounts'] = next;
    group[providerId] = provider;
    writeDoc(path, doc);

    return { providerId, name, chars: input.value.length };
}

/** 读 `model.yaml` 顶层的默认模型（`provider/model`）；没设 = null */
export function readDefaultModel(home: string): string | null {
    const value = readDoc(join(home, 'model.yaml'))['defaultModel'];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 写 / 清空默认模型（null 或空串 = 删除该字段） */
export function saveDefaultModel(home: string, modelKey: string | null): void {
    const path = join(home, 'model.yaml');
    const doc = readDoc(path);
    if (modelKey === null || modelKey.trim() === '') {
        delete doc['defaultModel'];
    } else {
        const key = modelKey.trim();
        if (!key.includes('/')) {
            throw new CatalogError('catalog/invalid-options', `默认模型必须写成 provider/model：${key}`, key);
        }
        doc['defaultModel'] = key;
    }
    writeDoc(path, doc);
}

// ── 内部 ─────────────────────────────────────────

function requireProviderId(providerId: string): string {
    const id = typeof providerId === 'string' ? providerId.trim() : '';
    if (id === '') throw new CatalogError('catalog/invalid-options', 'provider id 不能为空');
    if (/\s/.test(id)) throw new CatalogError('catalog/invalid-options', `provider id 不能含空白：${id}`, id);
    return id;
}

function existingKind(doc: Rec, providerId: string): 'std' | 'custom' | null {
    if (providerId in (asRecord(doc['stdProviders']) ?? {})) return 'std';
    if (providerId in (asRecord(doc['customProviders']) ?? {})) return 'custom';
    return null;
}

function ensureGroup(doc: Rec, kind: 'std' | 'custom'): Rec {
    const key = kind === 'std' ? 'stdProviders' : 'customProviders';
    const group = asRecord(doc[key]) ?? {};
    doc[key] = group;
    return group;
}

function mergeModelPatch(target: Rec, patch: ProviderModelPatch): Rec {
    const out: Rec = { ...target };
    if (patch.name !== undefined) out['name'] = patch.name;
    if (patch.contextWindow !== undefined) {
        const limit = asRecord(out['limit']) ?? {};
        limit['context'] = patch.contextWindow;
        out['limit'] = limit;
    }
    if (patch.cost !== undefined) {
        const cost = asRecord(out['cost']) ?? {};
        // 价目是整块覆盖：snake_case 三个字段按给定值写，其余（tiers 等）保留
        out['cost'] = {
            ...cost,
            input: patch.cost.input,
            output: patch.cost.output,
            ...(patch.cost.cacheRead === undefined ? {} : { cache_read: patch.cost.cacheRead }),
            ...(patch.cost.cacheWrite === undefined ? {} : { cache_write: patch.cost.cacheWrite }),
        };
    }
    return out;
}

function accountNameOf(account: Rec, index: number): string {
    return typeof account['name'] === 'string' ? account['name'] : String(index);
}

function readDoc(path: string): Rec {
    if (!existsSync(path)) return {};
    let raw: unknown;
    try {
        raw = loadYaml(readFileSync(path, 'utf-8'));
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new CatalogError('catalog/invalid-config', `${path} 解析失败：${message}`, path);
    }
    if (raw === null || raw === undefined) return {};
    if (!isRecord(raw)) throw new CatalogError('catalog/invalid-config', `${path} 顶层必须是映射`, path);
    return raw;
}

function writeDoc(path: string, doc: Rec): void {
    writeFileAtomic(path, dumpYaml(doc, { indent: 2, noRefs: true, lineWidth: 200 }));
}

function asRecord(value: unknown): Rec | null {
    return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Rec {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

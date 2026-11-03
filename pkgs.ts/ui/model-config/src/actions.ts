// actions.ts — 读 / 写配置的**纯函数**（不碰 DOM、不认识 Electron）。
//
// 文件 I/O 全部落在 @diy-agent/model-catalog（读侧 catalog.ts / 写侧 write.ts）；
// 本文件只做三件事：
//   ① 把「文件内容」投影成页面要的 ConfigSnapshot（脱敏在这一层完成，key 到此为止）
//   ② 把 renderer 传来的 unknown 参数校验成 catalog 的入参（形状不对就抛，不猜）
//   ③ 写后回一份新快照，renderer 不必自己拼第二份状态

import {
    listAccountStates,
    listProviders,
    loadCatalog,
    readDefaultModel,
    removeProvider,
    saveAccount,
    saveDefaultModel,
    saveProvider,
    type ModelCatalogCost,
    type ProviderModelPatch,
    type SavedAccount,
} from '@diy-agent/model-catalog';
import { ModelConfigPageError } from './errors.js';
import type { AccountStateView, ConfigSnapshot, ModelView, SavedAccountView, WriteResult } from './shared.js';

/** 读整页快照（**不含任何 key 值**） */
export function readSnapshot(home: string): ConfigSnapshot {
    const states = new Map(listAccountStates(home).map((item) => [item.providerId, item.accounts]));
    const models: ModelView[] = loadCatalog(home).map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        name: entry.name,
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.cost === undefined ? {} : { cost: entry.cost }),
    }));
    return {
        home,
        providers: listProviders(home).map((item) => ({
            ...item,
            accounts: (states.get(item.providerId) ?? []).map(accountView),
        })),
        models,
        defaultModel: readDefaultModel(home),
    };
}

function accountView(state: {
    readonly name: string;
    readonly configured: boolean;
    readonly chars?: number;
    readonly env: boolean;
}): AccountStateView {
    return {
        name: state.name,
        configured: state.configured,
        env: state.env,
        ...(state.chars === undefined ? {} : { chars: state.chars }),
    };
}

export { accountLabel, groupModels, modelKeyOf, savedAccountLabel } from "./format.js";

// ── 写方法（参数校验 + 调用 catalog + 回快照） ──────────

export function saveProviderAction(home: string, args: unknown): ConfigSnapshot {
    const input = recordOf(args, 'saveProvider');
    const providerId = stringOf(input['providerId'], 'providerId');
    const kind = input['kind'] === undefined ? undefined : kindOf(input['kind']);
    const spec = input['spec'] === undefined ? undefined : specOf(input['spec']);
    const models = input['models'] === undefined ? undefined : modelsOf(input['models']);
    saveProvider(home, {
        providerId,
        ...(kind === undefined ? {} : { kind }),
        ...(spec === undefined ? {} : { spec }),
        ...(models === undefined ? {} : { models }),
    });
    return readSnapshot(home);
}

export function removeProviderAction(home: string, args: unknown): ConfigSnapshot {
    const input = recordOf(args, 'removeProvider');
    removeProvider(home, stringOf(input['providerId'], 'providerId'));
    return readSnapshot(home);
}

export function saveAccountAction(home: string, args: unknown): WriteResult {
    const input = recordOf(args, 'saveAccount');
    const providerId = stringOf(input['providerId'], 'providerId');
    const name = stringOf(input['name'], 'name');
    const value = stringOf(input['value'], 'value');
    const saved: SavedAccount = saveAccount(home, { providerId, name, value });
    return {
        snapshot: readSnapshot(home),
        saved: { providerId: saved.providerId, name: saved.name, chars: saved.chars },
    };
}

export function saveDefaultModelAction(home: string, args: unknown): ConfigSnapshot {
    const input = recordOf(args, 'saveDefaultModel');
    const modelKey = input['modelKey'];
    if (modelKey !== null && typeof modelKey !== 'string') {
        throw new ModelConfigPageError('model-config/bad-args', 'modelKey 必须是字符串或 null');
    }
    saveDefaultModel(home, modelKey === null ? null : stringOf(modelKey, 'modelKey'));
    return readSnapshot(home);
}

// ── 内部校验 ─────────────────────────────────────

function recordOf(args: unknown, method: string): Record<string, unknown> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new ModelConfigPageError('model-config/bad-args', `${method} 需要对象参数`);
    }
    return args as Record<string, unknown>;
}

function stringOf(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new ModelConfigPageError('model-config/bad-args', `${field} 必须是字符串`);
    }
    return value;
}

function kindOf(value: unknown): 'std' | 'custom' {
    if (value !== 'std' && value !== 'custom') {
        throw new ModelConfigPageError('model-config/bad-args', 'kind 只能是 std / custom');
    }
    return value;
}

function specOf(value: unknown): { id?: string; npm?: string; api?: string } {
    const input = recordOf(value, 'spec');
    const out: { id?: string; npm?: string; api?: string } = {};
    for (const key of ['id', 'npm', 'api'] as const) {
        const raw = input[key];
        if (raw === undefined) continue;
        out[key] = stringOf(raw, `spec.${key}`);
    }
    return out;
}

function modelsOf(value: unknown): Record<string, ProviderModelPatch> {
    const input = recordOf(value, 'models');
    const out: Record<string, ProviderModelPatch> = {};
    for (const [modelId, raw] of Object.entries(input)) {
        const patch = recordOf(raw, `models.${modelId}`);
        const name = patch['name'] === undefined ? undefined : stringOf(patch['name'], 'name');
        const contextWindow = patch['contextWindow'] === undefined ? undefined : numberOf(patch['contextWindow']);
        const cost = patch['cost'] === undefined ? undefined : costOf(patch['cost']);
        out[modelId] = {
            ...(name === undefined ? {} : { name }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(cost === undefined ? {} : { cost }),
        };
    }
    return out;
}

function costOf(value: unknown): ModelCatalogCost {
    const input = recordOf(value, 'cost');
    return {
        input: numberOf(input['input']),
        output: numberOf(input['output']),
        ...(input['cacheRead'] === undefined ? {} : { cacheRead: numberOf(input['cacheRead']) }),
        ...(input['cacheWrite'] === undefined ? {} : { cacheWrite: numberOf(input['cacheWrite']) }),
    };
}

function numberOf(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ModelConfigPageError('model-config/bad-args', '数值字段必须是有限数字');
    }
    return value;
}

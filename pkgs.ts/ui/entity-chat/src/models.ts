// models.ts —— 模型目录的**视图类型与纯函数**。数据从服务端来（`diy2.models.list`，真源 = model.yaml）。
//
// 这里原先自带一张 `PROVIDERS` 表（端点 / 账号 / 价目 / 上下文窗口），是**第三份真源**：
// 加一个 provider 要改三处（服务端 `PROVIDERS_API`、这张表、配置），而它们各自演进 ——
// 症状是「界面上能选，服务端发不出去」。现在界面只认形状，不认具体有哪几家。
//
// 形状本身住在 `@diy-agent/protocol`（服务端由目录生成、界面消费，同一份）：
// 本文件只做**别名**，不再定义第二份 —— 否则「两边漂移」只是换了个地方发生。
//
// 边界：本文件不读环境、不发请求、不含任何 provider / model 常量。

import type {
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
    ModelCostView,
} from '@diy-agent/chat-transport-rpc';

export type ModelCost = ModelCostView;
export type ModelInfo = ModelCatalogModel;
export type Provider = ModelCatalogProvider;
export type ProviderAccount = ModelCatalogProvider['accounts'][number];
/** `diy2.models.list` 的回包（与协议的 `ModelCatalogSnapshot` 同一个形状） */
export type ModelCatalogPayload = ModelCatalogSnapshot;

/** 三段式：`account@provider/model` */
export interface ModelKey {
    provider: string;
    account: string;
    model: string;
}

export function formatModelKey(key: ModelKey): string {
    return `${key.account}@${key.provider}/${key.model}`;
}

/**
 * 解析 `account@provider/model`；格式不对 = undefined（**不猜一个默认值**）。
 *
 * 旧版会退回「目录里的第一项」——那等于把用户的模型静默换成别人的（账目、限流全跑偏），
 * 而且换完之后界面上还显示得挺正常。
 */
export function parseModelKey(value: string): ModelKey | undefined {
    const at = value.indexOf('@');
    const slash = value.indexOf('/', at + 1);
    if (at <= 0 || slash <= at + 1 || slash === value.length - 1) return undefined;
    return { account: value.slice(0, at), provider: value.slice(at + 1, slash), model: value.slice(slash + 1) };
}

export function findProvider(providers: readonly Provider[], id: string): Provider | undefined {
    return providers.find((provider) => provider.id === id);
}

/** 这个 key 对应的模型条目（provider 也参与匹配：同一个 modelId 可能挂在多家下面） */
export function modelOfKey(providers: readonly Provider[], value: string): ModelInfo | undefined {
    const key = parseModelKey(value);
    if (key === undefined) return undefined;
    return findProvider(providers, key.provider)?.models.find((model) => model.id === key.model);
}

/**
 * 这个模型**收不收图**（能不能把 image part 送到它眼前）。
 *
 * 判据与服务端完全一致（entity-runtime 的 `acceptsImagesOf`）：目录里没标能力位 ⇒ **不收**。
 * 界面上宁可保守 —— 让人在贴图前就知道「这张图这个模型看不到」，而不是发完等一个 400。
 */
export function acceptsImages(providers: readonly Provider[], modelKey: string): boolean {
    return modelOfKey(providers, modelKey)?.input?.includes('image') === true;
}

/**
 * 目录里第一个**收图**的模型 key（`account@provider/model`）。
 *
 * 用途只有一个：贴了图但当前模型不收时，提示「换到它」并让用户一键切 —— 不自动切
 * （换模型动的是这一轮的成本与配额，得由人点）。
 */
export function firstVisionModelKey(providers: readonly Provider[]): string | undefined {
    for (const provider of providers) {
        const account = provider.accounts.find((item) => item.configured) ?? provider.accounts[0];
        if (account === undefined) continue;
        const model = provider.models.find((item) => item.input?.includes('image') === true);
        if (model === undefined) continue;
        return formatModelKey({ provider: provider.id, account: account.name, model: model.id });
    }
    return undefined;
}

/** 「模型名 · 账号@provider」；目录里没有这个模型 ⇒ 原样显示 key（不编造名字） */
export function modelLabel(providers: readonly Provider[], value: string): string {
    const key = parseModelKey(value);
    if (key === undefined) return value;
    const info = modelOfKey(providers, value);
    return `${info?.name ?? key.model} · ${key.account}@${key.provider}`;
}

export function contextWindowOf(providers: readonly Provider[], value: string): number | undefined {
    return modelOfKey(providers, value)?.contextWindow;
}

export function contextWindowLabel(providers: readonly Provider[], value: string): string {
    const size = contextWindowOf(providers, value);
    if (size === undefined) return '窗口未知';
    return `${Math.round(size / 1024)}k 上下文`;
}

/**
 * 目录里的第一个「能真用」的模型：优先**已配 key**的账号。
 *
 * 只在「服务端/本地都没定缺省值」时兜底用（新装机器、model.yaml 没有 defaultModel）。
 */
export function firstUsableModelKey(providers: readonly Provider[]): string | undefined {
    for (const provider of providers) {
        const account = provider.accounts.find((item) => item.configured) ?? provider.accounts[0];
        const model = provider.models[0];
        if (account === undefined || model === undefined) continue;
        return formatModelKey({ provider: provider.id, account: account.name, model: model.id });
    }
    return undefined;
}

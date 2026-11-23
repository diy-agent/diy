// providers.ts —— 模型接入：**目录与 key 都从 model.yaml 来**（`@diy-agent/model-catalog`），
// provider 的私有请求头从 `@diy-agent/llm-provider/strategies` 来。
//
// 本文件里**没有任何 provider 名单**：加一个 provider = 改 `model.yaml` / `providers.custom.yaml`，
// 不改代码。原先的 `PROVIDER_API` / `PROVIDER_ENV` 两张表就是「加 provider 要改服务端代码」的
// 由来 —— 它们与 `model.yaml` 各自演进，迟早对不上（而且没有一条测试能发现对不上）。
//
// 三件事分家（与两个包各自的边界一致）：
//   · **数据**（端点 / 模型 id / 上限 / 价目 / 账号名）：`@diy-agent/model-catalog`（不含 key 值）；
//   · **key 值**：单独一条 `readAccountValue()`，用完不打印；
//   · **provider 私有约定**（会话 header、缓存保留期 `prompt_cache_retention`）：
//     `@diy-agent/llm-provider/strategies`，按 **host** 认领，不按 provider 名分支。
//
// 唯一留在本文件里的常量是「场景缺省输出上限」—— 那是**我们的策略**，不是上游的事实。

import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { dirname, join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { bodyTransformFor, headersFor } from '@diy-agent/llm-provider/strategies';
import {
    effectiveMaxOutputTokens,
    listAccountStates,
    loadCatalog,
    readAccountValue,
    readDefaultModel,
    type ModelCatalogEntry,
} from '@diy-agent/model-catalog';
import type { ModelCatalogModel, ModelCatalogProvider, ModelCostView } from '@diy-agent/protocol';
import type { LanguageModel } from 'ai';

// 本机网络：IPv6 自动选择会挂（fetch/undici 连接超时），强制 IPv4
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

export interface ParsedModelKey {
    account: string;
    provider: string;
    model: string;
}

/**
 * 三段式 `account@provider/model` 解析。
 *
 * **格式不对就抛**（旧版会静默退回某个写死的默认模型）：退回意味着用**别人的账号**去发请求，
 * 而账目、限流、缓存全部记在那个账号上 —— 这种「看起来还能用」的错误最难查。
 */
export function parseModelKey(value: string): ParsedModelKey {
    const at = value.indexOf('@');
    const slash = value.indexOf('/', at + 1);
    if (at <= 0 || slash <= at + 1 || slash === value.length - 1) {
        throw new Error(`模型标识不合法：${JSON.stringify(value)}（应形如 account@provider/model）`);
    }
    return { account: value.slice(0, at), provider: value.slice(at + 1, slash), model: value.slice(slash + 1) };
}

/**
 * model.yaml 的路径（两档，优先级从高到低）：
 *   1. `DIY_MODEL_CONFIG` —— 显式文件（diy2 用它把「本实例的数据根」投影进来）；
 *   2. `DIY_HOME/model.yaml` —— 仓库口径：数据根下的配置（diy-app 的 AppConfig.diyHome 同一口径）。
 *   3. 都没有 → `undefined`：**不读任何文件**（key 只能从 env 拿）。
 *
 * 为什么必须参数化（##dev-app 构建对齐）：写死 `~/.diy/model.yaml` 时，把数据根换成
 * `run/diy-app/lab` 只隔离了 sqlite，配置仍读生产真账号 —— 「隔离」是假的：lab 里的实验
 * 会用生产 key，而任何人以为自己在沙箱里。
 *
 * 为什么删掉「回落 `~/.diy/model.yaml`」这一档（2026-11-23）：后两档（env 缺省 / 数据根缺省）
 * 只要有一档回指生产，隔离就是假的。测试实例应当**完整依赖自己的数据根**：缺配置就报「缺 key」，
 * 由 `scripts/seed-run-home.sh` 在准备阶段把 `~/.diy` 的配置**填充**进去（准备动作，不是运行时查找）。
 */
export function modelConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const explicit = env['DIY_MODEL_CONFIG']?.trim();
    if (explicit !== undefined && explicit !== '') return explicit;
    const home = env['DIY_HOME']?.trim();
    if (home !== undefined && home !== '') return join(home, 'model.yaml');
    return undefined;
}

/**
 * 模型目录根 = `model.yaml` 所在目录。
 *
 * `@diy-agent/model-catalog` 是按**目录**读的（`<home>/model.yaml` + `<home>/providers.custom.yaml`
 * + `<home>/data/models.dev.json`），而 diy2 的配置入口是「一个文件」（`DIY_MODEL_CONFIG`）。
 * 两者的连接点就是 `dirname` —— 所以这三个文件必须落在同一目录（`sha.sh sync` 与
 * `~/.diy/` 都是这个布局）。
 */
export function modelHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const path = modelConfigPath(env);
    return path === undefined ? undefined : dirname(path);
}

/**
 * 目录快照的位置（`<home>/data/models.dev.json`）。
 *
 * 给「缺没缺快照」一个唯一口径：缺快照 = 标准 provider 全部没有规格，而这要从界面看得见
 * （静默回落到别的目录才是错的）。
 */
export { snapshotPath } from '@diy-agent/model-catalog';

/** 「本实例没有模型配置」的统一话术（`undefined` 数据根的三个出口共用） */
const NO_MODEL_HOME = '本实例没有模型配置：需要 DIY_HOME（数据根，含 model.yaml）或 DIY_MODEL_CONFIG';

const NO_MODEL_HOME_HINT = '测试实例跑 ./scripts/seed-run-home.sh <数据根> 填充';

/** 对话场景的输出上限缺省（对齐老路径 `local-agent.ts` 的 16384 场景缺省） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * 本轮要发出去的 `max_tokens`。
 *
 * **为什么必须显式发**：不发就是吃服务端缺省（远小于上下文能吃的量）。模型写到一半被砍断时，
 * 流里只表现为 `finishReason: "length"` —— 不设值又不在收尾处读 finishReason，
 * 症状就是「执行一半就停下，UI 却显示完成」（`##429` 在老路径修过一次，迁移时丢了）。
 *
 * 优先级：env `DIY_LOCAL_MAX_OUTPUT_TOKENS` > 调用方传入 > **目录里该模型的 `limit.output`**
 * > 场景缺省。
 *
 * 中间那一档原先是一张写着「deepseek 8192」的硬编码表 —— 那张表挂在一个**目录里已经不存在**的
 * 模型 id 上（`deepseek-chat`），于是新模型（`deepseek-v4-pro`）反而被按 8192 截断：
 * 陈旧的真相比没有真相更糟。现在上限跟着模型走（models.dev 的 `limit.output`），
 * 想临时收窄用 env。
 */
export function maxOutputTokensOf(
    modelKey: string,
    explicit?: number,
    env: NodeJS.ProcessEnv = process.env,
): number {
    const fromEnv = Number.parseInt(env['DIY_LOCAL_MAX_OUTPUT_TOKENS'] ?? '', 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
    if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
    // 算上限**不许抛**：这是「算一个缺省值」的函数，测试 / 无目录房间里的 modelKey 可以是任意
    // 占位串（`'m'`）。真正拿它去建模型的是 `modelOf`，那里才该响亮失败。
    const key = maybeParseModelKey(modelKey);
    return key === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : effectiveMaxOutputTokens(catalogEntry(key, env), DEFAULT_MAX_OUTPUT_TOKENS);
}

/**
 * 该模型的**上下文窗口**（token）。未知 = undefined（**不猜**）。
 *
 * 压缩判据的唯一输入：触发线与保留量都由它派生（见 compaction.ts）。猜一个窗口的后果是
 * 「要么永远不触发、要么一上来就把历史压光」—— 两种都比不压更难查。
 */
export function contextWindowOf(modelKey: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
    const key = maybeParseModelKey(modelKey);
    if (key === undefined) return undefined;
    const window = catalogEntry(key, env)?.contextWindow;
    return window !== undefined && window > 0 ? window : undefined;
}

/** `parseModelKey` 的容错版（算缺省值时用）：格式不对 = undefined，不抛 */
function maybeParseModelKey(value: string): ParsedModelKey | undefined {
    try {
        return parseModelKey(value);
    } catch {
        return undefined;
    }
}

/**
 * 目录里的一条（**必须 providerId + modelId 同时匹配**）。
 *
 * 同一个 modelId 可能挂在多个 provider 下（`deepseek-v4-pro` 直连与网关都有），只按 modelId
 * 找会拿到别人的 baseURL ⇒ 请求发到错的端点，上游不回应（实测表现就是「请求超时」）。
 */
function catalogEntry(key: ParsedModelKey, env: NodeJS.ProcessEnv): ModelCatalogEntry | undefined {
    const home = modelHome(env);
    if (home === undefined) return undefined;
    return loadCatalog(home, { env }).find(
        (entry) => entry.providerId === key.provider && entry.modelId === key.model,
    );
}

/** 取某账号的 key；失败时把「数据根在哪」带进错误（否则只看到「没有这个账号」） */
function accountKey(home: string, key: ParsedModelKey, env: NodeJS.ProcessEnv): string {
    try {
        return readAccountValue(home, key.provider, key.account, { env });
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`取不到 ${key.provider}/${key.account} 的 key：${message}（数据根 ${home}）`);
    }
}

export interface ModelOptions {
    /**
     * 会话 id（provider 的会话路由 / 亲和键；opencode 网关缺了它直接 400 `MissingSessionID`）。
     * 真源在调用方（session 用 bot id），本文件**不推算**。
     */
    sessionId?: string;
    /** 注入的环境（测试用；缺省 `process.env`） */
    env?: NodeJS.ProcessEnv;
}

/**
 * `account@provider/model` → ai-sdk 的 `LanguageModel`。
 *
 * 仍然用 `@ai-sdk/openai-compatible` 建模型（不是 `@diy-agent/llm-provider` 的 `LlmPort`）：
 * 本包的 agent 要的是 ai-sdk 的 `streamText` 全套钩子（`prepareStep` 每步注入变量增量 /
 * `onStepFinish` 回传 transcript / steering），而 `LlmPort` 是「文本 + 工具」的窄接口，
 * 换过去会把动态上下文这条链路拆掉。这里接的是它的**策略层**（header / 端点规则），
 * 不是它的传输层 —— 各取所长。
 */
export function modelOf(modelKey: string, options: ModelOptions = {}): LanguageModel {
    const env = options.env ?? process.env;
    const home = modelHome(env);
    if (home === undefined) throw new Error(`${NO_MODEL_HOME}；${NO_MODEL_HOME_HINT}`);
    // 空 key = 「用这个数据根的默认模型」。**解析放在这里、而不是写在行里**：房间 / bot 的行
    // 比配置活得久（配置常是后补的，行是先建的），把默认值抄进行里 =「配好了还得逐个房间改」。
    const resolved = modelKey.trim() === '' ? defaultModelKeyOf(env) : modelKey;
    if (resolved === undefined) {
        throw new Error(
            `没有指定模型，且 ${home}/model.yaml 里没有 defaultModel（不会去别处找）` +
                `，也没配账号 —— 填充：./scripts/seed-run-home.sh ${home}`,
        );
    }
    const key = parseModelKey(resolved);
    const entry = catalogEntry(key, env);
    if (entry === undefined) {
        throw new Error(
            `模型目录里没有 ${key.provider}/${key.model}（数据根 ${home}：` +
                'model.yaml 没配这个 provider，或 providers.custom.yaml / models.dev 快照里没有这个模型）',
        );
    }
    const apiKey = accountKey(home, key, env);
    // 端点 / 私有 header 全按 entry.baseURL 的 host 认领（opencode 的 `x-opencode-session` 就是
    // 这么来的：以前在这里写死成 `'x-opencode-session': \`diy2-${Date.now()}\``，等于把网关
    // 约定抄进应用层，加第二个网关就得再抄一遍）
    const headers = options.sessionId === undefined ? {} : headersFor(entry.baseURL, { sessionId: options.sessionId });
    // 请求体变换（该端点要补的字段）：opencode 网关的 `prompt_cache_retention` 就是从这里进去的。
    // 缺了它自动前缀缓存只活 ~5 分钟，跨轮（间隔常 >5min）整段重算 —— 实测 120k prompt
    // 差 119,936 命中 tokens。`undefined` = 该端点没验证过这些字段 ⇒ 什么都不补
    // （**不挂恒等函数**，白复制一次 body）。
    const transformBody = bodyTransformFor(entry.baseURL);
    const provider = createOpenAICompatible({
        name: key.provider,
        baseURL: entry.baseURL,
        apiKey,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(transformBody === undefined ? {} : { transformRequestBody: transformBody }),
    });
    return provider(key.model) as unknown as LanguageModel;
}

// ── 目录 → UI 视图（选模型器 / 新建房间的缺省模型）──────────────────
//
// 为什么视图由这里出而不是界面自己写一张表：界面表（`entity-chat/src/models.ts` 的
// `PROVIDERS`）是**第三份**真源，还带价目与上下文窗口 —— 它跟 model.yaml 各自演进，
// 结果就是「界面上能选、服务端发不出去」或者反过来。数据只走一条路：
// model.yaml →（本函数）→ `diy2.models.list` → 界面。

// 视图形状住在 `@diy-agent/protocol`（服务端与界面共用一份）：
// `ModelCostView` / `ModelCatalogModel` / `ModelCatalogProvider`。这里只做别名，
// 免得「界面定义一遍、服务端定义一遍」再漂一次 —— 那正是这次要消掉的问题。
export type ModelView = ModelCatalogModel;
export type ProviderView = ModelCatalogProvider;
export type { ModelCostView };

/**
 * 模型目录的 UI 视图：按 provider 分组，provider 按 id 排序、模型保持目录顺序（价目升序）。
 *
 * 只含「配了账号 + 有 baseURL」的 provider —— 与能不能真发请求同一判据（`loadCatalog` 的过滤）。
 */
export function modelProviders(env: NodeJS.ProcessEnv = process.env): ProviderView[] {
    const home = modelHome(env);
    if (home === undefined) return [];
    const accountsByProvider = new Map(listAccountStates(home).map((item) => [item.providerId, item.accounts]));
    const grouped = new Map<string, ProviderView>();
    for (const entry of loadCatalog(home, { env })) {
        let view = grouped.get(entry.providerId);
        if (view === undefined) {
            view = {
                id: entry.providerId,
                name: entry.providerId,
                api: entry.baseURL,
                ...(entry.npm === undefined ? {} : { npm: entry.npm }),
                accounts: (accountsByProvider.get(entry.providerId) ?? []).map((account) => ({
                    name: account.name,
                    configured: account.configured,
                })),
                models: [],
            };
            grouped.set(entry.providerId, view);
        }
        view.models.push({
            id: entry.modelId,
            name: entry.name,
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
            ...(entry.cost === undefined ? {} : { cost: entry.cost }),
        });
    }
    return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `model.yaml` 里写的默认模型（`defaultModel`）；没写 = undefined（**不猜**）。
 *
 * 猜（"第一个 provider 的第一个模型"）会让「换一台机器 → 默认模型变了」变得无法解释。
 */
export function defaultModelKeyOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const home = modelHome(env);
    return home === undefined ? undefined : (readDefaultModel(home) ?? undefined);
}

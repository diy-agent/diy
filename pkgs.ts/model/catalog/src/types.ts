// types.ts — @diy-agent/model-catalog 的公开契约（纯类型，零 IO）。
//
// 本包只做一件事：把 `$DIY_HOME/model.yaml`（配置层）+ `$DIY_HOME/providers.custom.yaml`
// （spec 层）+ models.dev 快照（内置 spec，可选）投影成一份**可选的模型目录**。
//
// 硬边界（##465）：
//   · 目录里**没有 key 值** —— 只有账号名（`accounts: [{ name }]`）；取 key 走单独一条
//     `readAccountValue()`，调用方自己决定什么时候用、用完不打印。
//   · 不 import `@diy-agent/llm-provider`（目录是数据，provider 是行为）。

/** 目录里的一条模型（一个 provider × 一个 model） */
export interface ModelCatalogEntry {
    /** models.dev provider id 或 custom provider id（`providers.custom.yaml` 的键） */
    readonly providerId: string;
    /** 上游模型 id（原样进请求体 `model` 字段） */
    readonly modelId: string;
    /** 给人看的名字 */
    readonly name: string;
    /** 该 provider 的 upstream baseURL（不含 `/chat/completions`） */
    readonly baseURL: string;
    /** ai-sdk 包名（决定协议面）；spec 没写 = 缺省 */
    readonly npm?: string;
    /** 上下文窗口（tokens）；未知 = 缺省（不是 0） */
    readonly contextWindow?: number;
    /**
     * 单次输出上限（tokens）；未知 = 缺省（**不是 0**）。
     *
     * ⚠️ 缺省 ≠ 0：`streamText({ maxOutputTokens: 0 })` 会被 SDK 直接拒
     * （"maxOutputTokens must be >= 1"，##184 实测）。要发值时一律走
     * `effectiveMaxOutputTokens(entry, fallback)` —— 它保证结果 >= 1。
     */
    readonly maxOutputTokens?: number;
    /** 单价（$ / 1M tokens）；无价目 = 缺省（不算钱） */
    readonly cost?: ModelCatalogCost;
    /**
     * 推理强度候选（归一自 models.dev 的 reasoning_options）。只有 `type=effort` 的模型才有；
     * toggle / budget_tokens / 空数组 / 无字段 → 缺省（不推理或不能选 effort）。
     */
    readonly reasoning?: ModelCatalogReasoning;
    /** 输入模态（models.dev `modalities.input`）—— `canSeeImages` 与 UI 的「收不收图」都读它 */
    readonly input?: readonly ModelInputModality[];
    /** 能力标记（表格「能力」列）；缺省 = 上游没声明，不是「不支持」 */
    readonly capabilities?: ModelCatalogCapabilities;
}

/**
 * 能力标记（归一自 models.dev 的 attachment / reasoning / tool_call / structured_output / modalities）。
 * 五项独立；全未知时上层不产出本对象。
 */
export interface ModelCatalogCapabilities {
    /** 能读图（modalities.input 含 image） */
    readonly vision: boolean;
    readonly toolCall: boolean;
    readonly reasoning: boolean;
    readonly attachment: boolean;
    readonly structuredOutput: boolean;
    /** 可调温度（models.dev `temperature`） */
    readonly temperature: boolean;
    /** 开放权重 */
    readonly openWeights: boolean;
    /** 支持的输入模态（text / image / audio / video / pdf …；原样来自 modalities.input） */
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    /** 发布 / 更新日期（`YYYY-MM-DD`，上游原样） */
    readonly releaseDate?: string;
    readonly lastUpdated?: string;
}

/**
 * 推理能力：efforts = 该模型支持的具体档位（原样来自 models.dev values），
 * defaultEffort = 该模型的第一档（dsh 的 efforts[0]，也是「换模型默认」要写的值）。
 */
export interface ModelCatalogReasoning {
    readonly efforts: readonly string[];
    readonly defaultEffort: string;
}

/** 输入模态（与 models.dev 的 `modalities.input` 同一套词；多出来的丢） */
export type ModelInputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf';

/** 目录里的价目（camelCase；与 model.yaml 的 snake_case 解耦） */
export interface ModelCatalogCost {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
}

/** 一个 provider 的账号名清单 —— **只有名字**，绝不含 value */
export interface ProviderAccounts {
    readonly providerId: string;
    readonly kind: 'std' | 'custom';
    readonly names: readonly string[];
}

/** `loadCatalog` 的可选项 */
export interface CatalogOptions {
    /**
     * models.dev 快照路径（std provider 的 spec 来源）。
     * 缺省查找顺序：`<home>/data/models.dev.json` → 本仓 `apps/diy-app/src/main/data/models.dev.json`。
     * 都找不到 ⇒ std provider 只有 model.yaml 里显式覆盖过的模型。
     */
    readonly snapshotPath?: string;
    /** `$VAR` 展开用的环境（缺省 `process.env`） */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

// shared.ts — 主进程与 renderer 之间的线上形状（两端共用）。
//
// ⚠️ 这份形状里**永远没有 key 明文**：账号只有名字 / 是否已填 / 字符数。
// 写入方向（renderer → 主进程）的 `value` 是单向的：过去就落盘，回来只有 `{ chars }`。

/** 一个账号的展示状态（不含 key） */
export interface AccountStateView {
    readonly name: string;
    readonly configured: boolean;
    /** 字面量 key 的字符数；`$VAR` 引用时缺省 */
    readonly chars?: number;
    /** 值是环境变量引用 */
    readonly env: boolean;
}

/** provider 列表的一行（不含 key） */
export interface ProviderView {
    readonly providerId: string;
    readonly kind: 'std' | 'custom';
    readonly api?: string;
    readonly npm?: string;
    readonly modelCount: number;
    readonly accounts: readonly AccountStateView[];
}

/** 模型列表的一行（模型目录的投影；不含 key） */
export interface ModelView {
    readonly providerId: string;
    readonly modelId: string;
    readonly name: string;
    readonly contextWindow?: number;
    readonly cost?: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
    };
}

/** 整页快照 */
export interface ConfigSnapshot {
    /** 数据根（`$DIY_HOME`）；页头显示用 */
    readonly home: string;
    readonly providers: readonly ProviderView[];
    readonly models: readonly ModelView[];
    /** `model.yaml` 顶层 `defaultModel`（`provider/model`）；没设 = null */
    readonly defaultModel: string | null;
}

/** `saveAccount` 的返回：只有长度，没有原值 */
export interface SavedAccountView {
    readonly providerId: string;
    readonly name: string;
    readonly chars: number;
}

/** 写方法的统一返回：更新后的快照 + 可选提示 */
export interface WriteResult {
    readonly snapshot: ConfigSnapshot;
    readonly saved?: SavedAccountView;
}

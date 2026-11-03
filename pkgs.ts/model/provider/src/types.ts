// types.ts — @diy-agent/llm-provider 的公开形状（纯类型，零运行时依赖）。
//
// 边界：本包只认识「怎么把一段对话发出去、把流收回来」。
// 它不认识：谁在说话（人设 / 系统提示）、要不要重试、工具怎么执行、配置从哪个文件来。
// 那些都属于调用方 —— 配置一律由外部传进来，本包不读任何应用数据根。

/** 单价（$ / 1M tokens）。缺字段 = 该桶未定价（不是 0） */
export interface ModelCost {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
}

/** 目录里的一条模型元数据（形状照 diy-app 的 LocalModel 的**元数据部分**，数据各管各的） */
export interface ModelInfo {
    /** 上游模型 id（原样进请求体 `model` 字段） */
    readonly id: string;
    /** 给人看的名字 */
    readonly name: string;
    /** 上下文窗口（tokens）；缺省 = 未知（不是 0） */
    readonly contextWindow?: number;
    /** 价目；缺省 = 无价目（不算钱） */
    readonly cost?: ModelCost;
}

/**
 * 建立 provider 需要的**全部**输入（没有任何一项来自本包自己读的文件 / 环境变量）：
 * 调用方（宿主 / 应用 profile）负责给出 baseURL、密钥与缺省模型。
 */
export interface ProviderConfig {
    /** 上游基址，如 `https://api.deepseek.com/v1`（不带 `/chat/completions`） */
    readonly baseURL: string;
    /** 密钥（原样作 `Authorization: Bearer …`；本地免密钥服务给个占位串即可） */
    readonly apiKey: string;
    /** 缺省模型 id（`chat(messages, { model })` 可逐次覆盖） */
    readonly model: string;
    /** provider 名（只用于 ai-sdk 内部的错误 / 遥测标记，缺省 `diy-llm-provider`） */
    readonly name?: string;
    /** 额外请求头（原样转发） */
    readonly headers?: Readonly<Record<string, string>>;
    /** 注入的 fetch（测试用假 HTTP；缺省 = 全局 fetch） */
    readonly fetch?: typeof globalThis.fetch;
}

/**
 * token 用量（比 `SessionDelta` 的 `usage` 多两个缓存桶）。
 *
 * 为什么在 `usage` 增量之外单独定义：会话内核的 `usage` 增量只有 in / out
 * （它不该知道某家上游的缓存口径）；缓存读写是 provider 这一层才看得见的事实，
 * 故以**附加字段**的形式跟着同一条增量出去（结构上仍是合法的 `SessionDelta`）。
 */
export interface UsageDetail {
    /** 总输入（= 非缓存 + 缓存读 + 缓存写） */
    readonly inputTokens: number;
    /** 总输出（文本 + 思考） */
    readonly outputTokens: number;
    /** 缓存读（命中）；缺省 = 上游没报（不可测 ≠ 0） */
    readonly cacheReadTokens?: number;
    /** 缓存写；缺省 = 上游没报（chat 面通常拿不到） */
    readonly cacheWriteTokens?: number;
}

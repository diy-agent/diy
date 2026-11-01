// shared.ts — 主进程与 renderer 之间的线上形状（两端共用，避免各写一份）。
//
// ##499：消息由一段纯文本改成 **Block 列表**。Block 的 kind 是 **string 面不是字面量枚举** ——
// 插件可以自造 kind，UI 主代码一行不改；不认识的 kind 由 renderer 的 fallback 兜底。
// core 事件 → Block 的归一化在**主进程**（blocks.ts），renderer 不认识任何 core 事件名。

export interface Block {
    /** 类型标签。**string 不是字面量枚举** —— 插件可以自造 */
    readonly kind: string;
    /** 稳定 id（同一条消息内唯一；折叠状态 / diff 用） */
    readonly id: string;
    /** 所有载荷；UI 只对**内置 kind** 解析 */
    readonly data: Record<string, unknown>;
}

/** 内置 kind：UI 自带这三个渲染器，其余走注册表 / fallback */
export const BUILTIN_BLOCK_KINDS = ["text", "think", "tool"] as const;

// ── 内置三个 kind 的 data 形状（UI 认识这三个） ──

/** kind: "text" */
export interface TextBlockData {
    readonly text: string;
}

/** kind: "think" */
export interface ThinkBlockData {
    readonly text: string;
    readonly done?: boolean;
}

/** kind: "tool" */
export interface ToolBlockData {
    readonly name: string;
    /** 已格式化的参数摘要 */
    readonly args: string;
    readonly state: "running" | "ok" | "error";
    /** 一行结果摘要 */
    readonly summary?: string;
    /** 完整输出（折叠区里放） */
    readonly output?: string;
}

/** 一条展示用的消息（只有生成侧关心的字段；seq / at 等内部字段不过桥） */
export interface WireMessage {
    readonly role: "user" | "assistant";
    readonly blocks: readonly Block[];
}

/** 一条只有文本块的消息（本地占位：错误提示 / 乐观显示用） */
export function textMessage(role: "user" | "assistant", text: string): WireMessage {
    return { role, blocks: [{ kind: "text", id: "text-0", data: { text } }] };
}

/** `send` 方法的返回值：整条会话的当前消息线 */
export interface SendResult {
    readonly messages: readonly WireMessage[];
}

// ── 多 bot 模式（config.sessions 注入时启用；单会话模式不受影响） ──
//
// ##498：左栏从「会话列表」换成「bot 列表」。
//   · 一个 bot 一个**长期会话**（`primary()`），点进去就是它 —— 没有「新建会话」这个概念
//   · 新建的是 **bot**（`+ 新 bot`），缺省选中第一个 / 上次选中的
//   · 消息线仍是 `@diy-agent/session` 的那一条，只是归属从「会话」挪到了「bot」

/** 模型选择器的一项（来自 model-catalog；不含任何 key） */
export interface ModelChoice {
    readonly providerId: string;
    readonly modelId: string;
    readonly name: string;
    /** 单价（$ / 1M tokens）；无价目 = 缺省（首启页显示「无价目」，不编数字） */
    readonly cost?: { readonly input: number; readonly output: number };
    /** 上下文窗口（tokens）；未知 = 缺省 */
    readonly contextWindow?: number;
}

/**
 * 左栏里的一行 bot（##498）。
 *
 * `model` 为空串 / `needsModel: true` ⇒ 存量数据还没选过模型，**UI 必须拦住**：
 * 不进聊天，先走模型补选页（绝不静默用「宿主缺省」替用户做决定）。
 */
export interface BotView {
    readonly id: string;
    readonly name: string;
    /** 行为指令（配置页回填用） */
    readonly instructions: string;
    /** 默认模型限定名 `providerId/modelId` */
    readonly model: string;
    readonly needsModel: boolean;
    /** 推理强度档位；没设 = 缺省 */
    readonly reasoningEffort?: string;
    /** 归属这个 bot 的会话数（扫会话目录的投影；卡片与配置页显示用） */
    readonly sessionCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * 底部一条里的指标（##498）。
 *
 * 语义与 `runtime.self` 同一把尺子，但只取「**上一步**」：
 *   · `inputTokens` / `outputTokens` / `cacheReadTokens` = 上一次 send 的那一步
 *   · `contextWindow` = 模型目录里该模型的上下文窗口（未知 ⇒ 缺席，不编数字）
 *   · `cost` = 上一步花费（USD；模型无价目 ⇒ 缺席）
 *   · `turns` = 这条会话已完成的轮数（「上下文 N step」里的 N）
 *
 * 全部缺席 = 还没发过消息 / 宿主不计量 —— UI 显示「—」，不显示 0。
 */
export interface ChatMetrics {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly contextWindow?: number;
    readonly cost?: number;
    readonly turns: number;
}

/** 整页的快照（选 bot / 改配置 / 删除 / 发送后都回这一份） */
export interface ChatSnapshot {
    /** 左栏：全部 bot（按 id 序） */
    readonly bots: readonly BotView[];
    /** 当前 bot；`null` = 还没有 bot（首启 ⇒ 显示引导页，不进聊天） */
    readonly bot: BotView | null;
    readonly models: readonly ModelChoice[];
    /** 当前 bot 的长期会话；null = 还没有（首启 / 刚建 bot） */
    readonly activeId: string | null;
    readonly messages: readonly WireMessage[];
    /** 底部指标；没东西可报 = null */
    readonly metrics: ChatMetrics | null;
    /** 新建 bot 的缺省模型（模型目录第一个） */
    readonly selectedModel: string | null;
}

/** `send` 的参数（#498：会话由当前 bot 决定，所以只带正文） */
export interface SendArgs {
    readonly text: string;
}

/** 首启建 bot 的输入（模型必选；名字 / 指令可改，缺省由宿主填） */
export interface FirstBotInput {
    readonly model: string;
    readonly name?: string;
    readonly instructions?: string;
}

/** 新建 bot 的输入（`+ 新 bot`；模型必选） */
export interface BotDraftInput {
    readonly name: string;
    readonly model: string;
    readonly instructions?: string;
    readonly reasoningEffort?: string;
}

/** 改 bot 配置的输入（字段缺省 = 不改） */
export interface BotUpdateInput {
    readonly id: string;
    readonly name?: string;
    readonly model?: string;
    readonly instructions?: string;
    readonly reasoningEffort?: string;
}

/**
 * 多 bot 宿主端口（由装配层注入；插件不碰文件系统 / 不读配置）。
 *
 * ##498：没有 `createSession` / `selectSession` / `deleteSession` —— 会话跟着 bot 走，
 * 点一个 bot 就是打开它的长期会话。
 */
export interface ChatSessionHost {
    snapshot(): Promise<ChatSnapshot>;
    /** 首启：建第一个 bot（已有 bot 就抛）；#497 */
    createFirstBot(input: FirstBotInput): Promise<ChatSnapshot>;
    /** 新建 bot（`+ 新 bot`）；建好即选中 */
    createBot(input: BotDraftInput): Promise<ChatSnapshot>;
    /** 改 bot 配置（名字 / 模型 / 推理强度 / 指令） */
    updateBot(input: BotUpdateInput): Promise<ChatSnapshot>;
    /** 删 bot（#498 判据 7：它的会话一并删除），并选中下一个 */
    removeBot(id: string): Promise<ChatSnapshot>;
    /** 切 bot（= 打开它的长期会话） */
    selectBot(id: string): Promise<ChatSnapshot>;
    /** 发送并等流结束；`onDelta` 用于把中间态推给 renderer */
    send(text: string, onDelta: (messages: readonly WireMessage[]) => void): Promise<ChatSnapshot>;
}

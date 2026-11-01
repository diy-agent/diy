// shared.ts — 主进程与 renderer 之间的线上形状（两端共用，避免各写一份）。

/** 一条展示用的消息（只有生成侧关心的字段；seq / at 等内部字段不过桥） */
export interface WireMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

/** `send` 方法的返回值：整条会话的当前消息线 */
export interface SendResult {
    readonly messages: readonly WireMessage[];
}

// ── 多会话模式（config.sessions 注入时启用；单会话模式不受影响） ──

/** 左侧会话列表的一项 */
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    /** 模型限定名 `providerId/modelId` */
    readonly model: string;
    /** ISO 时间 */
    readonly updatedAt: string;
    readonly messageCount: number;
}

/** 顶部模型选择器的一项（来自 model-catalog；不含任何 key） */
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
 * 当前 bot 的可见状态（##497）。
 *
 * `model` 为空串 / `needsModel: true` ⇒ 存量数据还没选过模型，**UI 必须拦住**：
 * 不进聊天，先走模型补选页（绝不静默用「宿主缺省」替用户做决定）。
 */
export interface BotView {
    readonly id: string;
    readonly name: string;
    readonly model: string;
    readonly needsModel: boolean;
}

/** 多会话模式下整页的快照（切换 / 新建 / 删除后都回这一份） */
export interface ChatSnapshot {
    /** 当前 bot；`null` = 还没有 bot（首启 ⇒ 显示模型选择页，不进聊天） */
    readonly bot: BotView | null;
    readonly sessions: readonly SessionSummary[];
    readonly models: readonly ModelChoice[];
    /** 当前打开的会话；null = 还没有会话 */
    readonly activeId: string | null;
    readonly messages: readonly WireMessage[];
    /** 新建会话将使用的模型限定名 */
    readonly selectedModel: string | null;
}

/** 多会话模式下 `send` 的参数 */
export interface MultiSendArgs {
    readonly sessionId: string;
    readonly text: string;
}

/** 首启建 bot 的输入（模型必选；名字 / 指令可改，缺省由宿主填） */
export interface FirstBotInput {
    readonly model: string;
    readonly name?: string;
    readonly instructions?: string;
}

/** 存量数据补选模型的输入（只改 model） */
export interface BotModelInput {
    readonly model: string;
}

/**
 * 多会话宿主端口（由装配层注入；插件不碰文件系统 / 不读配置）。
 * 方法都是 async，宿主自己决定懒打开。
 */
export interface ChatSessionHost {
    snapshot(): Promise<ChatSnapshot>;
    /** 首启：建第一个 bot（已有 bot 就抛）；#497 */
    createFirstBot(input: FirstBotInput): Promise<ChatSnapshot>;
    /** 存量数据补选模型（bot 存在但 model 缺失）；#497 */
    setBotModel(input: BotModelInput): Promise<ChatSnapshot>;
    create(input: { readonly model?: string }): Promise<ChatSnapshot>;
    select(id: string): Promise<ChatSnapshot>;
    remove(id: string): Promise<ChatSnapshot>;
    /** 发送并等流结束；`onDelta` 用于把中间态推给 renderer */
    send(id: string, text: string, onDelta: (messages: readonly WireMessage[]) => void): Promise<ChatSnapshot>;
}

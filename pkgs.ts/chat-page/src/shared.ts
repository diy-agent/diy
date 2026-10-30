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
}

/** 多会话模式下整页的快照（切换 / 新建 / 删除后都回这一份） */
export interface ChatSnapshot {
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

/**
 * 多会话宿主端口（由装配层注入；插件不碰文件系统 / 不读配置）。
 * 方法都是 async，宿主自己决定懒打开。
 */
export interface ChatSessionHost {
    snapshot(): Promise<ChatSnapshot>;
    create(input: { readonly model?: string }): Promise<ChatSnapshot>;
    select(id: string): Promise<ChatSnapshot>;
    remove(id: string): Promise<ChatSnapshot>;
    /** 发送并等流结束；`onDelta` 用于把中间态推给 renderer */
    send(id: string, text: string, onDelta: (messages: readonly WireMessage[]) => void): Promise<ChatSnapshot>;
}

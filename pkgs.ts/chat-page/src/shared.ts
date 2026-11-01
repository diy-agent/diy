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

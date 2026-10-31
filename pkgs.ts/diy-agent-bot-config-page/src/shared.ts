// shared.ts — 主进程与 renderer 之间的线上形状（两端共用）。
//
// 只放**可结构化克隆**的纯数据：bot 定义是文件里的那几项，测试对话只有 role / text。
// 没有 key、没有活对象、没有会话存储句柄 —— 那些都留在主进程。

/** 模型目录的一行（页面下拉用；不含 key） */
export interface ModelOptionView {
    readonly providerId: string;
    readonly modelId: string;
    readonly name: string;
}

/** bot 列表的一行 */
export interface BotView {
    readonly id: string;
    readonly name: string;
    readonly instructions: string;
    /** 默认模型限定名 `providerId/modelId`；null = 跟随宿主缺省 */
    readonly model: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** 归属这个 bot 的会话数（扫 sessions 目录的投影，不是 bot.json 的一部分） */
    readonly sessionCount: number;
}

/** 整页快照 */
export interface BotSnapshot {
    /** 数据根（`$DIY_HOME`）；页头显示用 */
    readonly home: string;
    readonly bots: readonly BotView[];
    /** 模型目录（编辑下拉 / 测试对话用） */
    readonly models: readonly ModelOptionView[];
    /** `model.yaml` 顶层 `defaultModel`；没设 = null */
    readonly defaultModel: string | null;
}

/** 测试对话里的一条消息（与 chat-page 的线上形状同口径） */
export interface TestMessageView {
    readonly role: 'user' | 'assistant';
    readonly text: string;
}

/** 测试对话的状态（**内存会话**：没有任何磁盘痕迹） */
export interface TestChatView {
    readonly botId: string;
    readonly messages: readonly TestMessageView[];
    readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly turns: number;
    };
    /** 恒为 true，提醒 renderer「这段对话不会出现在会话列表」 */
    readonly ephemeral: true;
}

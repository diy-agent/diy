// types.ts — bot 的实体与端口（零 IO：文件怎么放归 store-fs）
//
// 边界（##469）：bot 是**身份 + 会话归属**，不依赖协作空间、任务、模型、文件系统。
// 记忆接口先留空（Body 明确：这一刀不做记忆）。

/** bot 的 id（目录名；只允许字母数字与 `-_.`） */
export type BotId = string;

/**
 * `~/.diy/bots/<id>/bot.json` 的形状。
 *
 * ##470（bot = 人设）：本形状 = 人物定义（`persona.ts` 的 PersonaDef）+ id + 时间。
 * 行为指令字段名与 PersonaDef 一致叫 `instructions`（旧字段名 `persona` 由 store-fs 读兼容）。
 * `reasoningEffort` / `maxOutputTokens` 跟随人物定义保持可选（bot.json 允许只写最小身份）。
 */
export interface BotConfig {
    readonly id: BotId;
    readonly name: string;
    /** 行为指令（注入 system prompt 的身份节；空串 = 不注入） */
    readonly instructions: string;
    /** 默认模型限定名 `providerId/modelId`；未指定 = 跟随宿主缺省 */
    readonly model?: string;
    /** 推理强度档位；未指定 = 跟随模型缺省 */
    readonly reasoningEffort?: string;
    /** 输出软上限（tokens）；未指定 = 跟随场景缺省 */
    readonly maxOutputTokens?: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** 一条会话归属（session 是主体；这里只是投影给 bot 列表用） */
export interface BotSessionRef {
    readonly id: string;
    readonly botId: BotId;
    /** 会话 meta.json 的 updatedAt（宿主没写就不带） */
    readonly updatedAt?: string;
}

/**
 * bot 与会话归属的存储端口。
 *
 * 会话归属选**方案 B**：session 目录里存 `bot.json`（`{ botId }`），
 * 不是 `bot.json` 里存 `sessionIds` —— session 是主体，删 bot 不该丢会话数据。
 */
export interface BotStore {
    load(id: BotId): Promise<BotConfig | null>;
    save(config: BotConfig): Promise<void>;
    list(): Promise<readonly BotConfig[]>;
    /** 只删 bot 本身（`bots/<id>/`）；会话目录一个不动 */
    remove(id: BotId): Promise<void>;

    /** 这个会话归谁（读 `<sessionsDir>/<sessionId>/bot.json`）；没有归属 = null */
    ownerOf(sessionId: string): Promise<BotId | null>;
    /** 记归属（`<sessionsDir>/<sessionId>/bot.json`）；目录不存在则创建 */
    assign(sessionId: string, botId: BotId): Promise<void>;
    /** 扫 sessionsDir，列出归属这个 bot 的会话（别的 bot 的不出现） */
    sessionsOf(botId: BotId): Promise<readonly BotSessionRef[]>;
}

/** 一个 bot 句柄：配置 + 会话集合 + 新建会话 */
export interface Bot {
    readonly config: BotConfig;
    /** 这个 bot 的所有会话（按更新时间倒序；**不含**别的 bot 的） */
    sessions(): Promise<readonly BotSessionRef[]>;
    /** 新建一个会话（归属这个 bot），返回会话 id */
    newSession(): Promise<string>;
}

/** 建 bot 句柄的选项 */
export interface CreateBotOptions {
    /**
     * 存储端口。**缺省 = 本包自带的内存实现**（`createMemoryBotStore()`，不落盘）。
     * 要落盘由装配器实例化后传进来（`createFileBotStore({ home, sessionsDir })`）—— 本包不分派策略（##480）。
     */
    readonly store?: BotStore;
    readonly config: BotConfig;
    /**
     * 建会话本体（写 meta / 开桶是宿主的事）；缺省 = 只生成一个 id 并记归属。
     * 宿主注入时通常先建目录再返回 id，随后本包写 `bot.json`。
     */
    readonly createSession?: (bot: BotConfig) => Promise<string>;
}

/** 新 bot 的草案（id / 时间由 store 补） */
export interface BotDraft {
    readonly id: BotId;
    readonly name: string;
    readonly instructions: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly maxOutputTokens?: number;
}

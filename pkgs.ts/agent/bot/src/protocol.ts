// protocol.ts — bot 与界面之间的**线上形状**（纯数据 + 纯映射，不碰 IO / DOM）。
//
// 为什么住在本包：
//   · `createBotChat()` 产出的就是这份快照（`BotChatSnapshot`），会话消息 → 消息线的
//     归一化也在主进程侧做完（`wireOf`）—— 界面只负责画。
//   · chat-page 的 renderer 要用同一份形状：`@diy-agent/bot/protocol` 子路径是纯的
//     （没有 node:*），renderer 引它不会把文件系统带进浏览器包。
//
// ##499：消息由一段纯文本改成 **Block 列表**。Block 的 kind 是 **string 面不是字面量枚举** ——
// 插件可以自造 kind，UI 主代码一行不改；不认识的 kind 由 renderer 的 fallback 兜底。
// core 事件 → Block 的归一化在**主进程**（本文件），renderer 不认识任何 core 事件名。

import type { ChatMessage } from "@diy-agent/session";

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
// ##498：左栏是 **bot 列表**（一个 bot 一个长期会话），点进去就是它 ——
// 没有「新建会话 / 会话列表」这个概念（##505：会话只是 model 的内部技术）。
//   · 新建的是 **bot**（`+ 新 bot`），缺省选中第一个 / 本次进程里上次选中的
//   · 消息线仍是 `@diy-agent/session` 的那一条，只是归属从「会话」挪到了「bot」

/** 模型选择器的一项（来自 model-catalog；不含任何 key） */
export interface ModelChoice {
    /**
     * 账号名（`model.yaml` 里该 provider 下的 accounts[].name）。
     *
     * 为什么模型选择要带 account：一个 provider 可以有多个账号（aug / chen56 …），
     * key 不同、配额不同、稳定性也不同。diy-app 的模型列表一直是 `account@provider/model`
     * 三段式（shared/model-config.ts 的 splitQualified），bot 之前只有 provider/model 两段。
     */
    readonly account?: string;
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

/**
 * 整页的快照（选 bot / 改配置 / 删除 / 发送后都回这一份）。
 *
 * ##505：没有 `activeId` / 会话列表 —— 会话是 bot 的内部实现，不外露。
 */
export interface BotChatSnapshot {
    /** 左栏：全部 bot（按 id 序） */
    readonly bots: readonly BotView[];
    /** 当前 bot；`null` = 还没有 bot（首启 ⇒ 显示引导页，不进聊天） */
    readonly bot: BotView | null;
    readonly messages: readonly WireMessage[];
    /** 底部指标；没东西可报 = null */
    readonly metrics: ChatMetrics | null;
}

/**
 * 模型目录（`models` 方法的结果）。
 *
 * ##526：**不再塞进快照**。模型目录来自 model.yaml + providers.custom.yaml + models.dev.json
 * （4.6 MB 的 spec 快照），只有「配模型 / 新建 bot」时才需要，而切 bot 是高频动作 ——
 * 两者放在同一条快照里，等于每次切 bot 都为一件不相干的事付费。
 */
export interface ModelChoices {
    readonly choices: readonly ModelChoice[];
    /** 新建 bot 的缺省模型（目录第一个，三段式 `account@provider/model`）；目录空 = null */
    readonly defaultModel: string | null;
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
 * bot 对话宿主端口（由装配层构造；插件不碰文件系统 / 不读配置）。
 *
 * ##505：没有 `createSession` / `selectSession` / `deleteSession` —— 会话是 bot 的内部技术，
 * 点一个 bot 就是打开它的长期会话。
 */
export interface BotChatHost {
    snapshot(): Promise<BotChatSnapshot>;
    /** 模型目录（**按需拉**，不进快照：见 ModelChoices 的注释） */
    models(): Promise<ModelChoices>;
    /** 首启：建第一个 bot（已有 bot 就抛）；#497 */
    createFirstBot(input: FirstBotInput): Promise<BotChatSnapshot>;
    /** 新建 bot（`+ 新 bot`）；建好即选中 */
    createBot(input: BotDraftInput): Promise<BotChatSnapshot>;
    /** 改 bot 配置（名字 / 模型 / 推理强度 / 指令） */
    updateBot(input: BotUpdateInput): Promise<BotChatSnapshot>;
    /** 删 bot（#498 判据 7：它的会话一并删除），并选中下一个 */
    removeBot(id: string): Promise<BotChatSnapshot>;
    /** 切 bot（= 打开它的长期会话） */
    selectBot(id: string): Promise<BotChatSnapshot>;
    /** 发送并等流结束；`onDelta` 用于把中间态推给 renderer */
    send(text: string, onDelta: (messages: readonly WireMessage[]) => void): Promise<BotChatSnapshot>;
    /**
     * 压缩点（只读，供二级面板渲染）：一轮一行 + 当前边界 + 窗口 + 价格原料。
     * 语义与 diy-app 的 `compact.ledger` 一致，只是数据来自 **Agent 内存态**而不是回放。
     */
    compactInfo(): Promise<CompactInfo>;
    /**
     * 显式压缩：保留最近 `keepRounds` 轮（0 = 压缩到头）。
     * 返回新快照 —— 与其它变更方法同一口径（UI 整页重绘，不做增量合并）。
     */
    compact(keepRounds: number): Promise<BotChatSnapshot>;
}

/** 压缩点面板要的只读数据 */
export interface CompactInfo {
    /** 当前会话的轮次（旧 → 新）；`kept=false` 表示已被压掉（仍列出但不可选回来） */
    readonly rounds: readonly { readonly label: string; readonly title: string; readonly kept: boolean }[];
    /** 已压掉、选不回来的轮数 */
    readonly droppedCount: number;
    /** 模型窗口（未知 ⇒ undefined，不编数字） */
    readonly windowTokens?: number;
    /** 上一步实测占用（拿不到 ⇒ undefined） */
    readonly usedTokens?: number;
}

// ── core 事件 → Block 的归一化（主进程侧） ──
//
// 映射表：
//   text-delta      → text（相邻合并）
//   reasoning-delta → think（相邻合并，结束时 done:true）
//   tool-call       → tool（state=running）
//   tool-result     → 更新对应 tool block 的 state/summary/output
//   error           → tool（state=error）
//   不认识          → 丢弃 + debug 日志（不往 UI 传）

/**
 * core 事件。**开放形状**：`type` 是 string，本包只解释下面几张已知的脸，
 * 其余原样进 `toBlocks` 的 else 分支（丢弃 + debug）。
 */
export interface AgentEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

/** 单条文本 / 推理的摘要长度上限（参数摘要同理） */
const SUMMARY_MAX = 120;

/**
 * 把一串 core 事件折成 Block 列表。
 * 相邻同类 text / think 合并（一次模型输出常被切成几十个 delta）。
 */
export function toBlocks(events: readonly AgentEvent[]): Block[] {
    const blocks: Block[] = [];
    let seq = 0;
    for (const event of events) {
        const last = blocks.at(-1);
        switch (event.type) {
            case "text-delta": {
                const text = str(event["text"]);
                if (text === "") break;
                if (last !== undefined && last.kind === "text") {
                    const prev = str(last.data["text"]);
                    (last.data as Record<string, unknown>)["text"] = prev + text;
                } else {
                    blocks.push({ kind: "text", id: `b${seq++}`, data: { text } });
                }
                break;
            }
            case "reasoning-delta": {
                const text = str(event["text"]);
                if (text === "") break;
                if (last !== undefined && last.kind === "think") {
                    const prev = str(last.data["text"]);
                    (last.data as Record<string, unknown>)["text"] = prev + text;
                } else {
                    blocks.push({ kind: "think", id: `b${seq++}`, data: { text, done: false } });
                }
                break;
            }
            case "tool-call": {
                const id = str(event["id"]);
                blocks.push({
                    kind: "tool",
                    id: `b${seq++}`,
                    data: {
                        toolId: id,
                        name: str(event["name"]),
                        args: argsText(event["args"]),
                        state: "running",
                    },
                });
                break;
            }
            case "tool-result": {
                const id = str(event["id"]);
                const target = findTool(blocks, id) ?? lastTool(blocks);
                const content = str(event["content"]);
                if (target === undefined) {
                    // 没有对应调用（孤儿结果）：仍给一个 tool 块，别把信息吞掉
                    blocks.push({
                        kind: "tool",
                        id: `b${seq++}`,
                        data: {
                            toolId: id,
                            name: "",
                            args: "",
                            state: event["isError"] === true ? "error" : "ok",
                            summary: oneLine(content),
                            output: content,
                        },
                    });
                    break;
                }
                target.data["state"] = event["isError"] === true ? "error" : "ok";
                target.data["summary"] = oneLine(content);
                target.data["output"] = content;
                break;
            }
            case "error": {
                const message = str(event["message"]);
                blocks.push({
                    kind: "tool",
                    id: `b${seq++}`,
                    data: { name: "error", args: "", state: "error", summary: oneLine(message), output: message },
                });
                break;
            }
            default: {
                // 不认识的事件：丢弃 + debug 日志（renderer 不该被它绑死）
                console.debug(`[bot] 忽略未知事件类型: ${event.type}`);
                break;
            }
        }
    }
    // 收尾：还开着的 think 标 done
    for (const block of blocks) {
        if (block.kind === "think" && block.data["done"] !== true) {
            (block.data as Record<string, unknown>)["done"] = true;
        }
    }
    return blocks;
}

/**
 * session 消息线 → 线上消息线（Block 化）。
 *
 * `tool-result` 是独立的 role=tool 消息，但展示上它属于上一个 tool 块：
 * 这里就地更新那个块，不单独出一行（否则界面上会出现「调用」「结果」两条无主记录）。
 */
export function wireOf(messages: readonly ChatMessage[]): WireMessage[] {
    const out: WireMessage[] = [];
    let lastToolBlock: Block | null = null;
    for (const message of messages) {
        if (message.role === "system") continue;
        if (message.type === "tool-result") {
            const text = message.text ?? "";
            if (lastToolBlock !== null) {
                lastToolBlock.data["state"] = "ok";
                lastToolBlock.data["summary"] = oneLine(text);
                lastToolBlock.data["output"] = text;
            } else {
                out.push({
                    role: "assistant",
                    blocks: [
                        { kind: "tool", id: "tool-0", data: { name: "", args: "", state: "ok", summary: oneLine(text), output: text } },
                    ],
                });
            }
            continue;
        }
        const blocks = toBlocks(eventsOfMessage(message));
        if (blocks.length === 0) continue;
        out.push({ role: message.role === "user" ? "user" : "assistant", blocks });
        const tool = lastTool(blocks);
        if (tool !== undefined) lastToolBlock = tool;
    }
    return out;
}

/** 一条 session 消息 → core 事件（wireOf 的输入；消息类型在本文件里解释） */
export function eventsOfMessage(message: ChatMessage): AgentEvent[] {
    if (message.type === "tool-call") {
        const tool = toolOf(message.data);
        if (tool === null) return [];
        return [{ type: "tool-call", id: tool.id, name: tool.name, args: tool.args }];
    }
    const text = message.text ?? "";
    if (text === "") return [];
    // 语义分类 → 事件：tool-result 在外面单独处理；其余正文一律是文本
    return [{ type: "text-delta", text }];
}

function toolOf(data: unknown): { id: string; name: string; args: unknown } | null {
    if (data === null || typeof data !== "object") return null;
    const tool = (data as { tool?: unknown }).tool;
    if (tool === null || typeof tool !== "object") return null;
    const record = tool as Record<string, unknown>;
    return {
        id: typeof record["id"] === "string" ? record["id"] : "",
        name: typeof record["name"] === "string" ? record["name"] : "",
        args: record["args"],
    };
}

function findTool(blocks: readonly Block[], id: string): Block | undefined {
    if (id === "") return undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!;
        if (block.kind === "tool" && block.data["toolId"] === id) return block;
    }
    return undefined;
}

function lastTool(blocks: readonly Block[]): Block | undefined {
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!;
        if (block.kind === "tool") return block;
    }
    return undefined;
}

/** 参数 → 一行摘要（对象走 JSON，过长截断；已有字符串原样） */
function argsText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return clip(value);
    try {
        return clip(JSON.stringify(value));
    } catch {
        return "";
    }
}

function oneLine(text: string): string {
    return clip(text.replace(/\s+/g, " ").trim());
}

function clip(text: string): string {
    return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

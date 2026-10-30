// main.ts — 页面插件的主进程侧：一条会话 + 一个假 LlmPort + `send` 方法。
//
// 第一刀刻意**不接真模型**：把「UI 骨架对不对」从「LLM 通不通」里隔离出来。
// 会话本身是真的（@diy-agent/session）：发一条 user、收一条 assistant、消息线自己攒。
// 换真模型时只换 LlmPort，页面与外壳都不动 —— 现在就是这一步（##459）：
// profile（apps/minimal）在 `config.llm` 里塞一个真 provider，本插件不传就退回假回复。
//
// ##465：`config.sessions` 注入一个 **ChatSessionHost** 时切换成多会话模式（左侧列表 /
// 顶部模型选择器 / 主区消息流）。单会话模式（不注入）行为一字不变 —— apps/minimal 不受影响。

import { createSession, type ChatMessage, type LlmPort, type SessionStore } from "@diy-agent/session";
import type { PageContribution } from "@diy-agent/workbench";
import { ChatPageError } from "./errors.js";
import type {
    ChatSessionHost,
    ChatSnapshot,
    MultiSendArgs,
    SendResult,
    WireMessage,
} from "./shared.js";

/** 假回复的固定正文（第一刀的唯一输出） */
export const FAKE_REPLY = "这是一条固定的假回复 —— 第一刀只验 UI 链路，还没接真模型。";

/** 假 LlmPort：不管问什么，都回同一句话（仍走真流式增量契约） */
export function createFakeLlm(reply: string = FAKE_REPLY): LlmPort {
    return {
        async *chat(messages: readonly ChatMessage[]) {
            const inputChars = messages.reduce((sum, message) => sum + (message.text?.length ?? 0), 0);
            yield { type: "text", text: reply };
            yield { type: "usage", inputTokens: inputChars, outputTokens: reply.length };
            yield { type: "done", stopReason: "stop" };
        },
    };
}

/** 插件加载器会调用它（default 导出 = 本函数） */
export function createPage(config?: unknown): PageContribution {
    const host = hostFrom(config);
    if (host !== undefined) {
        return {
            id: "chat",
            title: "聊天",
            methods: {
                snapshot: (): Promise<ChatSnapshot> => host.snapshot(),
                createSession: (args: unknown): Promise<ChatSnapshot> =>
                    host.create(args !== null && typeof args === "object" && typeof (args as { model?: unknown }).model === "string"
                        ? { model: (args as { model: string }).model }
                        : {}),
                selectSession: (args: unknown): Promise<ChatSnapshot> => host.select(sessionIdOf(args)),
                deleteSession: (args: unknown): Promise<ChatSnapshot> => host.remove(sessionIdOf(args)),
                send: async (args: unknown): Promise<ChatSnapshot> => {
                    const { sessionId, text } = multiSendArgsOf(args);
                    return host.send(sessionId, text, () => {
                        // 当前通道只有「最终消息线」；增量消费留给将来加事件通道
                    });
                },
            },
        };
    }

    const reply = replyFrom(config);
    // 真 provider 由 profile 传入；不传 = 假回复（UI 链路可单独验，见 ##457/#458）
    const llm = llmFrom(config);
    const store = storeFrom(config);
    const session = createSession({
        id: "chat-page",
        llm: llm ?? createFakeLlm(reply),
        // 落盘也由宿主注入（同 llm：位置归宿主，插件只认端口；不传 = 纯内存）
        ...(store === undefined ? {} : { store }),
        // 系统话术只属于「假模型」这条路：真 provider 那边提示词归 profile，本插件不代写
        ...(llm === undefined ? { system: "你是最小工作台的示例会话；当前使用的是假模型。" } : {}),
    });

    return {
        id: "chat",
        title: "聊天",
        methods: {
            async send(args: unknown): Promise<SendResult> {
                const text = typeof args === "string" ? args : "";
                if (text.trim().length === 0) {
                    throw new ChatPageError("chat/empty-text", "消息正文为空");
                }
                // 把流读完：增量与最终消息都由 session 记账，这里只要结束后的消息线
                for await (const _delta of session.send(text)) {
                    // 第一刀不消费增量（真模型接入时在这里往 renderer 推进度）
                }
                return { messages: wireOf(session.messages) };
            },
        },
    };
}

export default createPage;

// ── 单会话模式的配置解析 ─────────────────────────

/** 从 config 取注入的 LlmPort（形状对不上就当没传 —— 配置错误不该静默变成空回复） */
function llmFrom(config: unknown): LlmPort | undefined {
    if (!config || typeof config !== "object") return undefined;
    const candidate = (config as { llm?: unknown }).llm;
    if (!candidate || typeof candidate !== "object") return undefined;
    const chat = (candidate as { chat?: unknown }).chat;
    return typeof chat === "function" ? (candidate as LlmPort) : undefined;
}

/** 从 config 取注入的 SessionStore（形状对不上就当没传 —— 与 llmFrom 同一把尺子） */
function storeFrom(config: unknown): SessionStore | undefined {
    if (!config || typeof config !== "object") return undefined;
    const candidate = (config as { store?: unknown }).store;
    if (!candidate || typeof candidate !== "object") return undefined;
    const port = candidate as Record<string, unknown>;
    const ok = ["append", "readFrom", "readRange", "latestSeq"].every((key) => typeof port[key] === "function");
    return ok ? (candidate as SessionStore) : undefined;
}

function replyFrom(config: unknown): string {
    if (config && typeof config === "object" && typeof (config as { reply?: unknown }).reply === "string") {
        return (config as { reply: string }).reply;
    }
    return FAKE_REPLY;
}

// ── 多会话模式的配置解析 ─────────────────────────

/** 从 config 取注入的 ChatSessionHost（形状对不上 = 单会话模式） */
function hostFrom(config: unknown): ChatSessionHost | undefined {
    if (!config || typeof config !== "object") return undefined;
    const candidate = (config as { sessions?: unknown }).sessions;
    if (!candidate || typeof candidate !== "object") return undefined;
    const port = candidate as Record<string, unknown>;
    const ok = ["snapshot", "create", "select", "remove", "send"].every((key) => typeof port[key] === "function");
    return ok ? (candidate as ChatSessionHost) : undefined;
}

function sessionIdOf(args: unknown): string {
    const id = args !== null && typeof args === "object" ? (args as { id?: unknown }).id : args;
    if (typeof id !== "string" || id.trim() === "") {
        throw new ChatPageError("chat/empty-text", "缺少会话 id");
    }
    return id;
}

function multiSendArgsOf(args: unknown): MultiSendArgs {
    if (args === null || typeof args !== "object") throw new ChatPageError("chat/empty-text", "缺少参数");
    const { sessionId, text } = args as { sessionId?: unknown; text?: unknown };
    if (typeof sessionId !== "string" || sessionId.trim() === "") throw new ChatPageError("chat/empty-text", "缺少会话 id");
    if (typeof text !== "string" || text.trim() === "") throw new ChatPageError("chat/empty-text", "消息正文为空");
    return { sessionId, text };
}

/** session 消息 → 线上形状 */
export function wireOf(messages: readonly ChatMessage[]): WireMessage[] {
    const out: WireMessage[] = [];
    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        out.push({ role: message.role, text: message.text ?? "" });
    }
    return out;
}

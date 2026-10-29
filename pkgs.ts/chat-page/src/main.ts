// main.ts — 页面插件的主进程侧：一条会话 + 一个假 LlmPort + `send` 方法。
//
// 第一刀刻意**不接真模型**：把「UI 骨架对不对」从「LLM 通不通」里隔离出来。
// 会话本身是真的（@diy/session）：发一条 user、收一条 assistant、消息线自己攒。
// 换真模型时只换 LlmPort，页面与外壳都不动 —— 现在就是这一步（##459）：
// profile（apps/minimal）在 `config.llm` 里塞一个真 provider，本插件不传就退回假回复。

import { createSession, type ChatMessage, type LlmPort } from "@diy/session";
import type { PageContribution } from "@diy/workbench";
import { ChatPageError } from "./errors.js";
import type { SendResult, WireMessage } from "./shared.js";

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
    const reply = replyFrom(config);
    // 真 provider 由 profile 传入；不传 = 假回复（UI 链路可单独验，见 ##457/#458）
    const llm = llmFrom(config);
    const session = createSession({
        id: "chat-page",
        llm: llm ?? createFakeLlm(reply),
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

/** 从 config 取注入的 LlmPort（形状对不上就当没传 —— 配置错误不该静默变成空回复） */
function llmFrom(config: unknown): LlmPort | undefined {
    if (!config || typeof config !== "object") return undefined;
    const candidate = (config as { llm?: unknown }).llm;
    if (!candidate || typeof candidate !== "object") return undefined;
    const chat = (candidate as { chat?: unknown }).chat;
    return typeof chat === "function" ? (candidate as LlmPort) : undefined;
}

function replyFrom(config: unknown): string {
    if (config && typeof config === "object" && typeof (config as { reply?: unknown }).reply === "string") {
        return (config as { reply: string }).reply;
    }
    return FAKE_REPLY;
}

function wireOf(messages: readonly ChatMessage[]): WireMessage[] {
    const out: WireMessage[] = [];
    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        out.push({ role: message.role, text: message.text ?? "" });
    }
    return out;
}

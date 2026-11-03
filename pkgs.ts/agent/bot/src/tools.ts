// tools.ts — bot 的工具**执行**（##514 第 3 步）
//
// 边界：bot 只负责「按模型点名的名字找到工具、执行、把结果交回 Session」。
//   · 工具**定义**（描述 / 参数 schema）在别处组装（`@diy-agent/tools` 的 `buildTools()`），
//     bot 不 import ai-sdk —— 这里用的是**结构化**类型：只要形状对得上（有 execute）就接得住，
//     换哪家工具定义都不改这里（判据同 @diy-agent/llm-provider「只翻译不绑 SDK」）。
//   · 执行失败**不抛**：转成一条失败结果（模型看得见原因才能改），与 diy-app 的
//     「工具错误也是数据」同口径 —— 抛会把整轮对话变红，而模型还有机会自我修正。

import type { ToolResultInput } from "@diy-agent/session";

/** 工具执行入参（ai-sdk `ToolCallOptions` 的结构子集：多传的字段它自己会忽略） */
export interface BotToolOptions {
    readonly toolCallId: string;
    readonly abortSignal?: AbortSignal;
}

/** 一个可执行工具（ai-sdk `Tool` 的结构子集，**只取 bot 用得到的部分**） */
export interface BotTool {
    readonly execute?: (input: unknown, options: BotToolOptions) => unknown;
}

/** 工具集（按模型给的名字查） */
export type BotToolSet = Readonly<Record<string, BotTool>>;

/** 模型要求的一次调用（从 `SessionDelta` 的 tool-call 提取） */
export interface PendingToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}

/** 结果正文上限（字符）：工具吐一整屏也会被塞进下一轮上下文，超了截断并标出 */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/** 执行一批调用，产出与之一一对应的 `ToolResultInput`（顺序保持一致） */
export async function runToolCalls(
    calls: readonly PendingToolCall[],
    tools: BotToolSet,
    options: { readonly abortSignal?: AbortSignal } = {},
): Promise<readonly ToolResultInput[]> {
    const out: ToolResultInput[] = [];
    for (const call of calls) {
        out.push({
            id: call.id,
            name: call.name,
            content: await runOne(call, tools, options.abortSignal),
        });
    }
    return out;
}

async function runOne(call: PendingToolCall, tools: BotToolSet, abortSignal: AbortSignal | undefined): Promise<string> {
    const tool = tools[call.name];
    if (tool === undefined) {
        return `[没有这个工具] ${call.name}（可用：${Object.keys(tools).join(" / ") || "（无）"}）`;
    }
    if (typeof tool.execute !== "function") {
        return `[工具不可执行] ${call.name}（这个工具只声明了 schema，没有 execute）`;
    }
    try {
        const result: unknown = await tool.execute(call.input, {
            toolCallId: call.id,
            ...(abortSignal === undefined ? {} : { abortSignal }),
        });
        return clip(textOf(result));
    } catch (error) {
        // **不抛**：失败也是模型需要看的事实（与 diy-app 的 tool-error 同口径，只是这里用文本表达）
        return clip(`[工具失败] ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 任意执行结果 → 文本（字符串原样；其余 JSON —— Session/协议最后都只要一段文本） */
function textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try {
        const text = JSON.stringify(value);
        return typeof text === "string" ? text : String(value);
    } catch {
        return String(value);
    }
}

function clip(text: string): string {
    if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
    const dropped = text.length - TOOL_RESULT_MAX_CHARS;
    return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…（工具结果过长，已截断 ${dropped} 字符）`;
}

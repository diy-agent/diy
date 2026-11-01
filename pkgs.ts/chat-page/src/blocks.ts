// blocks.ts — core 事件 → Block 的归一化（**主进程侧**，##499）。
//
// 边界：renderer 只认 shared.ts 的 `Block`，不认识这里的 event 名字。
// core 换事件名 / 加字段 / 加事件，只改这一处；UI 与插件都不动。
//
// 映射表（任务 body）：
//   text-delta      → text（相邻合并）
//   reasoning-delta → think（相邻合并，结束时 done:true）
//   tool-call       → tool（state=running）
//   tool-result     → 更新对应 tool block 的 state/summary/output
//   error           → tool（state=error）
//   不认识          → 丢弃 + debug 日志（不往 UI 传）

import type { ChatMessage } from "@diy-agent/session";
import type { Block, WireMessage } from "./shared.js";

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
                console.debug(`[chat-page] 忽略未知事件类型: ${event.type}`);
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

/** 一条 session 消息 → core 事件（wireOf 的输入；消息类型在 blocks.ts 里解释） */
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

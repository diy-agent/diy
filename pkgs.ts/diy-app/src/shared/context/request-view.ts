// src/shared/context/request-view.ts
// 🎯 「一次请求的实际投递内容」的展示模型 + 分层用量核算（纯函数）。
//
// 为什么要它：压缩预览要回答的是「**这次请求**到底长什么样、改参数后差在哪」——
// 必须能看到真实的 system / tools / messages 结构（而非另算一份投影），故由 main 用与
// 真发完全相同的组装链（assembleGlobals → buildDelivery → blocksToMessages）产出 RequestView。
// 分层核算（system / tools / user / assistant.text / assistant.tool / tool.result）是「事实表」
// 的数据源：它是纯账（字节 → token），不含任何预测。

import { utf8Bytes } from "./compaction";

/** 展示用的一次请求（字段名对齐真发：model / system / tools / messages） */
export interface RequestView {
    model: string;
    /** 系统提示词全文 */
    system: string;
    /** 工具定义（展示只给 name/description；完整 schema 字节数另由 toolsBytes 记） */
    tools: { name: string; description: string }[];
    /** 投递的消息（ModelMessage 形状；runtime 作为尾部 user 已并入） */
    messages: unknown[];
    /** tools 完整 schema 的字节数（与真发的 ctxParts.toolsBytes 同口径） */
    toolsBytes: number;
}

/** 一层在请求里的占比（事实表一行） */
export interface LayerRow {
    key: string;
    /** 中文说明（人读；括号里是它对应请求的哪个字段） */
    label: string;
    oldTokens: number;
    newTokens: number;
    /** 金额差（$）；负 = 省。按当前模型非缓存输入单价算 */
    costDelta: number;
}

/** 分层字节：从 messages 里按 role / part 类型拆 */
export interface MessageLayerBytes {
    user: number;
    assistantText: number;
    assistantTool: number;
    toolResult: number;
}

/** 单条 message 的字节按层归集（与 blocksToMessages 产出的形状对齐） */
export function messageLayerBytes(messages: readonly unknown[]): MessageLayerBytes {
    const acc: MessageLayerBytes = { user: 0, assistantText: 0, assistantTool: 0, toolResult: 0 };
    for (const m of messages) {
        const msg = m as { role?: string; content?: unknown };
        const content = msg.content;
        if (typeof content === "string") {
            if (msg.role === "user") acc.user += utf8Bytes(content);
            else acc.assistantText += utf8Bytes(content);
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const p = part as { type?: string; text?: string; input?: unknown; output?: { value?: string } };
            if (p.type === "text") acc.assistantText += utf8Bytes(p.text ?? "");
            else if (p.type === "tool-call") acc.assistantTool += utf8Bytes(JSON.stringify(p.input ?? {}));
            else if (p.type === "tool-result") acc.toolResult += utf8Bytes(p.output?.value ?? "");
        }
    }
    return acc;
}

/** 粗略 token 估算：字节/4（无 tokenizer；仅用于对比，不进计费） */
const tok = (bytes: number): number => Math.round(bytes / 4);

/**
 * 事实表：base（当前生效请求）vs mod（改参数后）。
 * @param inputRate 非缓存输入单价（$/1M）—— 用**全价**算差值：压缩改变的是"要重发的量"，
 *                  差值属于输入侧；缓存读折扣不进这里（那是另一个口径，且随前缀而定）。
 */
export function layerFacts(base: RequestView, mod: RequestView, inputRate: number): LayerRow[] {
    const b = messageLayerBytes(base.messages);
    const m = messageLayerBytes(mod.messages);
    const rows: { key: string; label: string; oldBytes: number; newBytes: number }[] = [
        { key: "total", label: "合计", oldBytes: 0, newBytes: 0 },
        { key: "system", label: "system — 系统提示词（人物行为指令 / 规则 / 保命契约 / AGENTS.md 链）", oldBytes: utf8Bytes(base.system), newBytes: utf8Bytes(mod.system) },
        { key: "tools", label: "tools — 工具定义（bash / read 等函数 schema）", oldBytes: base.toolsBytes, newBytes: mod.toolsBytes },
        { key: "user", label: "user — 用户消息（含 runtime 任务正文/技能清单）", oldBytes: b.user, newBytes: m.user },
        { key: "assistant.text", label: "assistant.text — 模型回复正文", oldBytes: b.assistantText, newBytes: m.assistantText },
        { key: "assistant.tool", label: "assistant.tool — 模型发起的工具调用（命令/参数）", oldBytes: b.assistantTool, newBytes: m.assistantTool },
        { key: "tool.result", label: "tool.result — 工具执行结果（可被头尾裁剪的部分）", oldBytes: b.toolResult, newBytes: m.toolResult },
    ];
    const rest = rows.slice(1).sort((a, x) => x.oldBytes - a.oldBytes);
    const toks = rest.map((r) => ({ oldTokens: tok(r.oldBytes), newTokens: tok(r.newBytes) }));
    // 总输入 = 各层 token 之和（**按展示值求和**，保证表格列加起来自洽；不做字节再估）
    const totalOld = toks.reduce((a, x) => a + x.oldTokens, 0);
    const totalNew = toks.reduce((a, x) => a + x.newTokens, 0);
    return [
        {
            key: "total",
            label: rows[0]!.label,
            oldTokens: totalOld,
            newTokens: totalNew,
            costDelta: ((totalNew - totalOld) / 1_000_000) * inputRate,
        },
        ...rest.map((r, i) => ({
            key: r.key,
            label: r.label,
            oldTokens: toks[i]!.oldTokens,
            newTokens: toks[i]!.newTokens,
            costDelta: ((toks[i]!.newTokens - toks[i]!.oldTokens) / 1_000_000) * inputRate,
        })),
    ];
}

/** 展示 YAML 的根对象（键序即阅读序：model → system → tools → messages） */
export function requestViewYaml(v: RequestView): Record<string, unknown> {
    return {
        model: v.model,
        system: v.system,
        tools: v.tools.map((t) => ({ name: t.name, description: t.description })),
        messages: v.messages,
    };
}

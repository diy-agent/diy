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
    /** 中文名（人读；表格「被压缩的历史消息」列直接展示它） */
    name: string;
    /** 详细说明（悬停提示用；含英文键与含义） */
    label: string;
    oldTokens: number;
    newTokens: number;
    /** 金额差（$）；负 = 省。按当前模型非缓存单价算 */
    costDelta: number;
    /** 这一层**当前**的输入费用（$）—— 图形对比用（= oldTokens/1M × 单价） */
    oldCost: number;
    /** 这一层**压缩后**的输入费用（$） */
    newCost: number;
}

/** 分层字节：从 messages 里按 role / part 类型拆 */
export interface MessageLayerBytes {
    user: number;
    assistantText: number;
    /** 推理内容（thinking 模式回传的 `reasoning_content`；##374 T2 起可被裁短 —— 所以它必须单独成层） */
    assistantReasoning: number;
    assistantTool: number;
    toolResult: number;
}

/** 单条 message 的字节按层归集（与 blocksToMessages 产出的形状对齐） */
export function messageLayerBytes(messages: readonly unknown[]): MessageLayerBytes {
    const acc: MessageLayerBytes = { user: 0, assistantText: 0, assistantReasoning: 0, assistantTool: 0, toolResult: 0 };
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
            // 推理**必须单独成层**：它既不是 text 也不是 tool-call，漏了它「合计」就会少算
            // （思考模式下推理可比正文大一个量级 —— 表里看不见 = 账算不平 = 压缩调不对）
            else if (p.type === "reasoning") acc.assistantReasoning += utf8Bytes(p.text ?? "");
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
 * @param inputRate 非缓存单价（$/1M）—— 用**全价**算差值：压缩改变的是"要重发的量"，
 *                  差值属于输入侧；缓存读折扣不进这里（那是另一个口径，且随前缀而定）。
 */
export function layerFacts(base: RequestView, mod: RequestView, inputRate: number): LayerRow[] {
    const b = messageLayerBytes(base.messages);
    const m = messageLayerBytes(mod.messages);
    const rows: { key: string; name: string; label: string; oldBytes: number; newBytes: number }[] = [
        { key: "total", name: "合计", label: "合计（各层之和）", oldBytes: 0, newBytes: 0 },
        { key: "system", name: "系统提示词", label: "system — 人物行为指令 / 规则 / 保命契约 / AGENTS.md 链", oldBytes: utf8Bytes(base.system), newBytes: utf8Bytes(mod.system) },
        { key: "tools", name: "工具定义", label: "tools — bash / read 等函数 schema（压缩动不了它）", oldBytes: base.toolsBytes, newBytes: mod.toolsBytes },
        { key: "user", name: "用户消息", label: "user — 用户消息（含 runtime 任务正文 / 技能清单）", oldBytes: b.user, newBytes: m.user },
        { key: "assistant.text", name: "模型回复", label: "assistant.text — 模型回复正文", oldBytes: b.assistantText, newBytes: m.assistantText },
        {
            key: "assistant.reasoning",
            name: "模型推理",
            label: "assistant.reasoning — 思考模式的推理内容（可被裁短、不可裁空）",
            oldBytes: b.assistantReasoning,
            newBytes: m.assistantReasoning,
        },
        { key: "assistant.tool", name: "工具调用", label: "assistant.tool — 模型发起的工具调用（命令 / 参数）", oldBytes: b.assistantTool, newBytes: m.assistantTool },
        { key: "tool.result", name: "工具结果", label: "tool.result — 工具执行结果（头尾裁剪作用于此）", oldBytes: b.toolResult, newBytes: m.toolResult },
    ];
    const rest = rows.slice(1).sort((a, x) => x.oldBytes - a.oldBytes);
    const toks = rest.map((r) => ({ oldTokens: tok(r.oldBytes), newTokens: tok(r.newBytes) }));
    // 总输入 = 各层 token 之和（**按展示值求和**，保证表格列加起来自洽；不做字节再估）
    const totalOld = toks.reduce((a, x) => a + x.oldTokens, 0);
    const totalNew = toks.reduce((a, x) => a + x.newTokens, 0);
    const usd = (tokens: number): number => (tokens / 1_000_000) * inputRate;
    return [
        {
            key: "total",
            name: rows[0]!.name,
            label: rows[0]!.label,
            oldTokens: totalOld,
            newTokens: totalNew,
            costDelta: usd(totalNew) - usd(totalOld),
            oldCost: usd(totalOld),
            newCost: usd(totalNew),
        },
        ...rest.map((r, i) => ({
            key: r.key,
            name: r.name,
            label: r.label,
            oldTokens: toks[i]!.oldTokens,
            newTokens: toks[i]!.newTokens,
            costDelta: usd(toks[i]!.newTokens) - usd(toks[i]!.oldTokens),
            oldCost: usd(toks[i]!.oldTokens),
            newCost: usd(toks[i]!.newTokens),
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

// ─── 预览预算（##406 刀 1）：把「给人看的副本」裁到有界 ────────────────
//
// 为什么要它：压缩预览面板对 **base / mod 两份完整请求**做节点级 diff 再全量渲染 DOM。
// ##401 那种 4.95 MB 请求 = 数万行 diff + 数万个节点 ⇒ 渲染进程卡死（用户实测「一进去就卡住」）。
// 裁剪**只作用于展示副本**：真发的内容一个字都不动，这里也不参与计价（计价另用原始请求）。
//
// 关键约束：**对称**。base 与 mod 用同一套阈值各裁各的 —— 于是「两侧都超长且内容相同」的块
// 会裁成同一段文本（仍判 same），只有真正不同的部分才产生 diff 行；不会因为裁剪本身制造假差异。
// （唯一的例外是占位文案里带了「原长度」：长度变了**本来就是**差异，保留它是有意的。）

export interface PreviewClipOpts {
    /** 单个字符串超过多少**字符**就裁（缺省 4000 —— 约 1 屏多，够看出是什么） */
    maxChars?: number;
    /** 数组元素上限（头尾各留一半；缺省 200） */
    maxItems?: number;
}

export interface PreviewClipStats {
    /** 被裁掉的字符总数（UI 报「预览已裁剪 X 字符」用） */
    droppedChars: number;
    /** 被裁掉的数组元素总数 */
    droppedItems: number;
}

const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_MAX_ITEMS = 200;

/** 递归裁剪一份**仅供展示**的副本（纯函数，不改入参） */
export function clipForPreview(value: unknown, opts?: PreviewClipOpts): { value: unknown; stats: PreviewClipStats } {
    const maxChars = opts?.maxChars ?? PREVIEW_MAX_CHARS;
    const maxItems = opts?.maxItems ?? PREVIEW_MAX_ITEMS;
    const stats: PreviewClipStats = { droppedChars: 0, droppedItems: 0 };

    const walk = (v: unknown): unknown => {
        if (typeof v === "string") {
            if (v.length <= maxChars) return v;
            // 头 70% / 尾 30%：开头通常说明「这是什么」，结尾常是结论 / 断点
            const head = Math.max(1, Math.floor(maxChars * 0.7));
            const tail = Math.max(0, maxChars - head);
            const dropped = v.length - head - tail;
            stats.droppedChars += dropped;
            return v.slice(0, head) + `\n…[预览已裁掉 ${dropped} 字符，原文 ${v.length} 字符]…\n` + (tail > 0 ? v.slice(-tail) : "");
        }
        if (Array.isArray(v)) {
            if (v.length <= maxItems) return v.map(walk);
            const headN = Math.ceil(maxItems / 2);
            const tailN = Math.floor(maxItems / 2);
            const dropped = v.length - headN - tailN;
            stats.droppedItems += dropped;
            return [
                ...v.slice(0, headN).map(walk),
                { "…": `预览已裁掉 ${dropped} 项（共 ${v.length} 项）` },
                ...v.slice(v.length - tailN).map(walk),
            ];
        }
        if (v && typeof v === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
        }
        return v;
    };

    return { value: walk(value), stats };
}

// src/shared/context/dropped.ts
// 🎯 被压缩区间的**索引注记**（形式 B 的唯一新增形态）—— 纯函数，禁止 import node:*
//
// ── 为什么是"文本嵌进原生 messages"而不是"整段历史变一份文档" ──
// 曾定过两种形式做对比实验：
//   A 整文档：把压缩后的历史整体渲染成一份 YAML，塞进**一条** user 消息。
//   B 原生+注记：messages 保持原样（provider 最友好），结构化索引只出现在"被丢的位置"。
// 用户 2026-10-06 拍定 B，理由（两条都是硬的）：
//   · A 的单条 user 可能超 provider 的单消息上限（大会话几 MB）；
//   · A 丢掉 role 交替 → 前缀缓存整个失效（B 的保留部分逐字不变，缓存仍命中）。
//
// ── 注记要回答的问题 ──
// 模型在自己缺信息时该能**回取**：去哪找（file）、找哪几行（range）、那一坨是什么（turns/tools/why）。
// 所以每个字段都指向一个"可动作"的事实，而不是给人看的统计报表。
//
// ── 为什么附 schema 注释（且**从 zod 派生**）──
// 实测（用户反馈）：模型对裸字段名常常理解偏差（把 range 当成字符偏移、把 turns 当轮数）。
// 于是把字段含义写在 YAML 上方的注释里 —— 注释也在它的上下文里，读起来零歧义。
// 但注释**不许手写**（手写 = 第二真源，改字段忘改注释就撒谎）：从下面的 zod 定义派生。

import { z } from "zod";
import { renderFieldDocs } from "../schema-doc";

/**
 * 一段被省去的历史（当前压缩只有"前缀整段"，故注记通常只有一段；
 * D3 的 `content: "text" | "conclusion"` 会产生**段内丢** → 那时就是多段）。
 *
 * 这里是**投递产物**（要贴给模型看），故用严格 `z.object`：多出字段没有意义，
 * 与日志那种"扩展松散"的读侧策略相反 —— 见 log-schema.ts。
 */
export const DroppedSegmentSchema = z.object({
    range: z
        .tuple([z.number(), z.number()])
        .describe("被省去的原文行号（含两端；1-based，等于 llm.jsonl 的物理行号）"),
    turns: z.array(z.string()).describe("被省去覆盖的轮次 id（t+毫秒时间戳）"),
    messages: z.number().describe("被省去的消息条数"),
    tools: z.array(z.string()).describe("这段里出现过的工具名（空 = 只有文本/思考）"),
    why: z.string().describe("为什么被省（策略推导，非模型生成）"),
    gist: z.string().optional().describe("一句话概述（勾选摘要并生成后才有内容）"),
});

export type DroppedSegment = z.infer<typeof DroppedSegmentSchema>;

/**
 * 校验一段注记数据。失败 = **异常数据**（用户 2026-10-06：不当成"可有可无"糊过去）。
 * 调用方据此决定：不投递（宁可不写也不写坏的）还是记一笔异常。
 */
export function parseDroppedSegment(
    x: unknown,
): { ok: true; value: DroppedSegment } | { ok: false; issues: string[] } {
    const r = DroppedSegmentSchema.safeParse(x);
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`) };
}

export interface DroppedNoteCtx {
    /** 原文路径（相对 $DIY_HOME —— 人/模型都能照此找到） */
    file: string;
    /** 原文绝对路径（bash 直接可用） */
    absPath?: string;
}

/** YAML 双引号标量（JSON 转义是 YAML 双引号转义的子集，见 shared/context/README 的块标量三条坑） */
function q(s: string): string {
    return JSON.stringify(s);
}

/**
 * 把被省区间渲染成一段**可直接插进 user 消息的文本**。
 * 形态：YAML 注释头（说明 + schema + 回取方法）+ 一条 `dropped:` 映射。
 */
export function renderDroppedNote(seg: DroppedSegment, ctx: DroppedNoteCtx): string {
    const L: string[] = [];
    L.push("# ── 会话历史（压缩视图）────────────────────────────────────────");
    L.push("# 以下是本次会话**较早的部分**，已按压缩策略省去（原文没有被删除）。");
    L.push(`# 原文：${ctx.file}${ctx.absPath ? `（${ctx.absPath}）` : ""}`);
    L.push("#   · 每 1 行 = 1 条消息，**行号即消息序号**");
    L.push(`#   · 回取（按行）：bash 里 \`sed -n '${seg.range[0]},${seg.range[1]}p' <原文>\``);
    // 兜底：行号是"日志补齐后"的位置，若盘上日志暂时落后于 ops（极端情形）会整体偏移；
    // 轮 id 写在每行的 turn 字段里，grep 一定命中 —— 两条路并存，模型任选。
    if (seg.turns.length > 0) {
        L.push(`#   · 回取（按轮）：bash 里 \`grep -n '"turn":"${seg.turns[0]}"' <原文>\``);
    }
    L.push("# 字段（由 zod 定义派生，勿手写）：");
    L.push(...renderFieldDocs(DroppedSegmentSchema));
    L.push("dropped:");
    L.push(`  range: [${seg.range[0]}, ${seg.range[1]}]`);
    L.push(`  turns: [${seg.turns.join(", ")}]`);
    L.push(`  messages: ${seg.messages}`);
    L.push(`  tools: [${seg.tools.join(", ")}]`);
    L.push(`  why: ${q(seg.why)}`);
    if (seg.gist) L.push(`  gist: ${q(seg.gist)}`);
    return L.join("\n");
}

/**
 * 取出投影结果里的「轮 id 序」（去重保序）与工具名（去重保序）—— 注记的数据源。
 * 只认**结构化字段**（role/turn/toolName），绝不解析 content 文本：那是用户数据，格式不可控。
 */
export function collectDroppedFacts(
    messages: readonly { role: string; content: unknown; turn?: string }[],
): { turns: string[]; tools: string[] } {
    const turns: string[] = [];
    const tools: string[] = [];
    for (const m of messages) {
        if (m.turn && !turns.includes(m.turn)) turns.push(m.turn);
        if (m.role !== "tool") continue;
        const parts = Array.isArray(m.content) ? (m.content as { toolName?: unknown }[]) : [];
        for (const p of parts) if (typeof p.toolName === "string" && !tools.includes(p.toolName)) tools.push(p.toolName);
    }
    return { turns, tools };
}

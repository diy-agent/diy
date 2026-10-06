// src/shared/context/dropped.ts
// 🎯 被压缩区间的**索引注记**（形式 B 的唯一新增形态）—— 纯函数，禁止 import node:*
//
// ── 为什么是"文本嵌进原生 messages"而不是"整段历史变一份文档" ──
// 曾定过两种形式做对比实验：
//   A 整文档：把压缩后的历史整体渲染成一份 YAML，塞进**一条** user 消息。
//   B 原生+注记：messages 保持原样（provider 最友好），结构化索引只出现在"被省的位置"。
// 用户 2026-10-06 拍定 B，理由（两条都是硬的）：
//   · A 的单条 user 可能超 provider 的单消息上限（大会话几 MB）；
//   · A 丢掉 role 交替 → 前缀缓存整个失效（B 的保留部分逐字不变，缓存仍命中）。
//
// ── 注记要回答的问题 ──
// 模型在自己缺信息时该能**回取**：去哪找（file）、找哪几行（range）、那一坨是什么（turns/tools/why）。
// 所以每个字段都指向一个"可动作"的事实，而不是给人看的统计报表。
//
// ── 为什么会**多段**（##269 D3b）──
// `content` 轴（只留文本 / 只留结论）会在**保留的轮里面**也省掉东西（工具链路、过程性文本）。
// 只报"前缀被省了多少轮"会让模型以为保留轮是完整的 —— 那是**说谎**（比不给索引更坏）。
// 所以注记是**分段**的，每段标注 `kind`：整轮被裁（turns）/ 保留轮内被裁（content）。
//
// ── 为什么附 schema 注释（且**从 zod 派生**）──
// 实测（用户反馈）：模型对裸字段名常常理解偏差（把 range 当成字符偏移、把 turns 当轮数）。
// 于是把字段含义写在 YAML 上方的注释里 —— 注释也在它的上下文里，读起来零歧义。
// 但注释**不许手写**（手写 = 第二真源，改字段忘改注释就撒谎）：从下面的 zod 定义派生。

import { z } from "zod";
import { renderFieldDocs } from "../schema-doc";

/**
 * 一段被省去的历史。
 *
 * 这里是**投递产物**（要贴给模型看），故用严格 `z.object`：多出字段没有意义，
 * 与日志那种"扩展松散"的读侧策略相反 —— 见 log-schema.ts。
 */
export const DroppedSegmentSchema = z.object({
    range: z
        .tuple([z.number(), z.number()])
        .describe("被省去的原文行号区间（含两端；1-based，等于 llm.jsonl 的物理行号）"),
    kind: z
        .enum(["turns", "content"])
        .describe("省去的类别：turns = 整个轮次被裁（在保留范围之外）；content = 保留轮**内部**被裁掉的内容"),
    turns: z.array(z.string()).describe("这段覆盖的轮次 id（t+毫秒时间戳）"),
    tools: z.array(z.string()).describe("这段里出现过的工具名（空 = 只有文本/思考）"),
    why: z.string().describe("为什么被省（由策略推导，非模型生成）"),
});

/**
 * 整份注记。
 *
 * 注意这里**没有** `messages` 字段：每段的条数恒等于区间长度（段按连续行号切），
 * 多存一个数就是**冗余**（冗余 = 两个数可能不一致 = 迟早不一致）。要总数看 `total`。
 * 也**没有** `gist`：一句话概述属于「摘要」，摘要是**另投一条消息**（##246 定稿），
 * 混进索引会让两件事互相污染。
 */
export const DroppedNoteSchema = z.object({
    total: z.number().describe("被省去的消息总数（= 各段区间长度之和）"),
    segments: z.array(DroppedSegmentSchema).describe("被省区间的分段（按原文行号升序；相邻且同类会合并）"),
});

export type DroppedSegment = z.infer<typeof DroppedSegmentSchema>;
export type DroppedNote = z.infer<typeof DroppedNoteSchema>;

/**
 * 校验一份注记。失败 = **异常数据**（用户 2026-10-06：不当成"可有可无"糊过去）。
 * 调用方据此决定：不投递（宁可不写也不写坏的）还是记一笔异常。
 */
export function parseDroppedNote(
    x: unknown,
): { ok: true; value: DroppedNote } | { ok: false; issues: string[] } {
    const r = DroppedNoteSchema.safeParse(x);
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`) };
}

export interface DroppedNoteCtx {
    /** 原文路径（相对 $DIY_HOME —— 人/模型都能照此找到） */
    file: string;
    /** 原文绝对路径（bash 直接可用） */
    absPath?: string;
    /**
     * 格式说明（字段表 + 回取法）是否**已经**随 system 的 `historyIndex` 节点投出去了。
     * true ⇒ 注记只留数据 + 一行指路（同一信息不投两遍；这也是"格式说明从 zod 派生、
     * 作为变量树节点进 system"的落地处）。
     * 缺省 false ⇒ 自带完整注释头（llm.jsonl 单独读时仍自解释）。
     */
    schemaInSystem?: boolean;
}

/** YAML 双引号标量（JSON 转义是 YAML 双引号转义的子集，见 shared/context/README 的块标量三条坑） */
function q(s: string): string {
    return JSON.stringify(s);
}

/**
 * 把注记渲染成一段**可直接插进 user 消息的文本**。
 * 形态：YAML 注释头（说明 + schema + 回取方法）+ `dropped:` 映射（分段）。
 */
export function renderDroppedNote(note: DroppedNote, ctx: DroppedNoteCtx): string {
    const first = note.segments[0];
    const L: string[] = [];
    if (ctx.schemaInSystem) {
        // 精简头：格式说明与回取法已在 system 的 historyIndex 节点里（不重复投）
        L.push("# ── 会话历史（压缩视图）：以下内容已按压缩策略省去（原文未被删除）");
        L.push("# 格式与回取法见 system 上下文的 historyIndex 节点；行号即消息序号");
        L.push("dropped:");
        L.push(`  total: ${note.total}`);
        L.push("  segments:");
        for (const s of note.segments) {
            L.push(`    - range: [${s.range[0]}, ${s.range[1]}]`);
            L.push(`      kind: ${s.kind}`);
            L.push(`      turns: [${s.turns.join(", ")}]`);
            L.push(`      tools: [${s.tools.join(", ")}]`);
            L.push(`      why: ${q(s.why)}`);
        }
        return L.join("\n");
    }
    L.push("# ── 会话历史（压缩视图）────────────────────────────────────────");
    L.push("# 以下是本次会话的**部分内容已按压缩策略省去**（原文没有被删除）。");
    L.push(`# 原文：${ctx.file}${ctx.absPath ? `（${ctx.absPath}）` : ""}`);
    L.push("#   · 每 1 行 = 1 条消息，**行号即消息序号**");
    if (first) {
        L.push(`#   · 回取（按行）：bash 里 \`sed -n '${first.range[0]},${first.range[1]}p' <原文>\``);
        // 兜底：行号是"日志补齐后"的位置，若盘上日志暂时落后于 ops（极端情形）会整体偏移；
        // 轮 id 写在每行的 turn 字段里，grep 一定命中 —— 两条路并存，模型任选。
        if (first.turns.length > 0) {
            L.push(`#   · 回取（按轮）：bash 里 \`grep -n '"turn":"${first.turns[0]}"' <原文>\``);
        }
    }
    L.push("# 字段（由 zod 定义派生，勿手写）：");
    L.push(...renderFieldDocs(DroppedNoteSchema));
    L.push("#   （segments 每一项）");
    L.push(...renderFieldDocs(DroppedSegmentSchema));
    L.push("dropped:");
    L.push(`  total: ${note.total}`);
    L.push("  segments:");
    for (const s of note.segments) {
        L.push(`    - range: [${s.range[0]}, ${s.range[1]}]`);
        L.push(`      kind: ${s.kind}`);
        L.push(`      turns: [${s.turns.join(", ")}]`);
        L.push(`      tools: [${s.tools.join(", ")}]`);
        L.push(`      why: ${q(s.why)}`);
    }
    return L.join("\n");
}

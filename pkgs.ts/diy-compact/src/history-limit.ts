// src/shared/context/history-limit.ts
// 🎯 压缩配置面（##442 最大精简）：只留 **summary.mode** 一项。
//
// 算法本体在 `./select-kept-boundary.ts`：
//   · 触发线 = `W − max(10%W, 16k)`（零旋钮）
//   · 保留量 = `W × 0.16`（固定）
//   · 切点 = 从尾往前装够后，往前挪到最近的 user
//
// 这里只负责 ① 摘要模式 schema ② 消息 → 边界形状的适配 ③ token 粗估。
// 没有 limitTokens / 下限夹取 / 保头 / 事后配平 / windowOverRatio。
//
// ⚠️ `summary.mode: model` 目前只表示「优先用已生成的摘要」；**压缩时自动生成摘要**
//    还没接进 compact 事务（2026-10-28 已知项）。摘要为空时通知会写「model 模式摘要未生成」，
//    与 `self` 区分。别把 model 当成已自动摘要。
//
// 纯函数：禁止 import node:*。

import { z } from "zod";

import { retainTokensOf, selectKeptBoundary, triggerTokensOf, type BoundaryMessage } from "./select-kept-boundary.js";

/** 摘要模式：`model` = 压缩时生成摘要；`self` = 只给 source，让模型自己查 */
export const SummaryModeSchema = z
    .enum(["model", "self"])
    .describe(
        "压缩后如何承接被压掉的内容：`model` = 压缩时先让模型读被压段产出摘要；" +
            "`self` = 不生成摘要，只给 llm 原文路径，让模型自己查。",
    );

/** 配置面 = 摘要模式（唯一一项） */
export const HistoryLimitSchema = z.object({
    summary: z.object({ mode: SummaryModeSchema }).describe("压缩后的承接方式"),
    /**
     * 模型窗口上限的**显式覆盖**（token）；只给「模型目录里没有 contextLimit」的自建/测试模型用。
     * 不填 = 取模型目录；两边都没有 ⇒ 不压（不猜数）。它不是保留量/触发线旋钮。
     */
    windowTokens: z.number().optional().describe("模型窗口上限（token）；不填则取模型目录"),
});

export type HistoryLimit = z.infer<typeof HistoryLimitSchema>;
export type SummaryMode = z.infer<typeof SummaryModeSchema>;

export const DEFAULT_HISTORY_LIMIT: HistoryLimit = { summary: { mode: "model" } };

/**
 * 宽松归一：读 `summary.mode`；旧字段（`limitTokens` / `summary.enabled`）一律忽略。
 * 出声由调用方负责（`isCompleteHistoryLimit` 为 false 时给一条 warning）。
 */
export function normalizeHistoryLimit(raw: unknown): HistoryLimit {
    const src = (raw ?? {}) as Record<string, unknown>;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    const mode = sum?.["mode"];
    const w = src["windowTokens"];
    return {
        summary: { mode: mode === "self" ? "self" : "model" },
        ...(typeof w === "number" && Number.isFinite(w) && w > 0 ? { windowTokens: Math.floor(w) } : {}),
    };
}

/** 配置是否完整（只用来出声；不完整照样能用） */
export function isCompleteHistoryLimit(raw: unknown): boolean {
    const src = (raw ?? {}) as Record<string, unknown>;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    return sum?.["mode"] === "model" || sum?.["mode"] === "self";
}

/**
 * token 粗估（CJK 感知）：CJK 码点 1 token/字，其余 4 字符 1 token。
 *
 * 只喂历史压缩边界；计费 / 窗口占比永远走 provider 回包的 usage。
 */
export function estimateTokensOf(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0) ?? 0;
        if (
            (c >= 0x3000 && c <= 0x30ff) ||
            (c >= 0x3400 && c <= 0x4dbf) ||
            (c >= 0x4e00 && c <= 0x9fff) ||
            (c >= 0xac00 && c <= 0xd7af) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0x20000 && c <= 0x3ffff)
        ) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    return Math.ceil(cjk + other / 4);
}

/** 算法只需要这几样（不绑 LocalModelMessage，便于单测与跨层复用） */
export interface CompactableMessage {
    role: string;
    content: unknown;
    /** 属于哪一轮（有它时切点吸附到轮首） */
    turn?: string;
}

export interface CompactableRange {
    /** 切点的消息下标（这条及之后保留；它之前全部丢弃） */
    cut: number;
    /** 本次丢掉的消息条数 */
    dropped: number;
    /** 保留段 token 估算 */
    retainedTokens: number;
}

export interface SelectRangeOpts {
    /** 当前模型窗口（token）；<= 0 = 不压（不猜数） */
    windowTokens: number;
    /**
     * 手动压缩：跳过「总装得下 / 压完仍超触发线」两条不压判据，
     * 并且至少再丢一个 user 边界（内容再小也真丢东西）。
     */
    force?: boolean;
    /** 已有边界的切点（force 时新切点必须 > 它，不能把历史又放回来） */
    minCut?: number;
    /** 每条消息的 token 成本（缺省 = 内容 JSON 的 CJK 感知粗估） */
    costOf?: (m: CompactableMessage, index: number) => number;
}

/** 从 `floor` 之后找第一条 user 消息（切点必须落在 user 上） */
function firstUserAfter(msgs: readonly BoundaryMessage[], floor: number): number {
    for (let i = Math.max(0, floor) + 1; i < msgs.length; i++) {
        if (msgs[i]!.user) return i;
    }
    return -1;
}

/** 下一条 user 必须是**新轮轮首**（force 时也不能把切点落回轮中插话） */
function firstTurnStartAfter(msgs: readonly BoundaryMessage[], floor: number): number {
    const fromTurn = msgs[Math.max(0, floor)]?.turn;
    if (!fromTurn) return firstUserAfter(msgs, floor);
    for (let i = Math.max(0, floor) + 1; i < msgs.length; i++) {
        const m = msgs[i]!;
        if (m.turn && m.turn !== fromTurn && m.user) return i;
    }
    return -1;
}

/**
 * **core 侧适配层**：把消息序列喂给唯一判据 `selectKeptBoundary`，再处理手动 force。
 *
 * 自动：总装得下 ⇒ null；压完仍超触发线 ⇒ null。
 * 手动（force）：总装得下 ⇒ 切到第二条 user（丢掉最老的一步/一轮）；已有边界 ⇒ 至少再前进一个 user。
 *
 * @returns `null` = 没有可丢的（不写边界）
 */
export function selectCompactableRange(
    all: readonly CompactableMessage[],
    opts: SelectRangeOpts,
): CompactableRange | null {
    const { windowTokens, force = false, minCut = 0 } = opts;
    const retainTokens = retainTokensOf(windowTokens);
    if (all.length === 0 || !(retainTokens > 0)) return null;
    const cost = opts.costOf ?? ((m: CompactableMessage) => estimateTokensOf(JSON.stringify(m.content ?? "")));
    const msgs: BoundaryMessage[] = all.map((m, i) => ({
        tokens: cost(m, i),
        user: m.role === "user",
        ...(m.turn ? { turn: m.turn } : {}),
    }));
    const triggerTokens = triggerTokensOf(windowTokens);

    const boundary = selectKeptBoundary(msgs, retainTokens, triggerTokens, { force });
    let cut = boundary.kind === "drop" ? boundary.cut : 0;

    if (force && cut <= minCut) {
        const next = firstTurnStartAfter(msgs, Math.max(cut, minCut));
        if (next < 0) return null;
        cut = next;
    }
    if (cut <= 0) return null;

    let retainedTokens = 0;
    for (let i = cut; i < msgs.length; i++) retainedTokens += msgs[i]!.tokens;
    return { cut, dropped: cut, retainedTokens };
}

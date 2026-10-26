// src/shared/context/history-limit.ts
// 🎯 **唯一的压缩算法**（##442，2026-10-27 向 dsh 看齐）：一个比例 + 一条切点规则。
//
//   保留量 = 模型窗口上限 × `RETAIN_RATIO(0.16)`；
//   从尾往前累加 token 直到装够，然后切点往前挪到最近的 **user 消息**；
//   压完仍超触发线 ⇒ 不压（空转判据）。
//
// 判据本体在 `./select-kept-boundary.ts`（与界面范例预览共用同一份），本文件只负责
// ① 配置形状（`retainRatio` + 摘要模式）、② 消息 → 边界形状的适配、③ token 粗估。
//
// 删掉的东西（见 `select-kept-boundary.ts` 头注，别再长回来）：
//   `limitTokens` 绝对上限 / `MIN_HISTORY_LIMIT_TOKENS` 下限夹取 / 旧 `budgetBytes` 折算 /
//   `HEAD_KEEP_TOKENS` 保头 / `RETAIN_RATIO = 0.5` 那层乘法 / `balanceCut` 事后配平。
//
// 「边界只在压缩事件时算一次并落盘」不变（##432）；落盘与每步追加归 `@diy/persistence`。
// 本文件是**纯函数**，禁止 import node:*。

import { z } from "zod";

import { hasDropped, RETAIN_RATIO, selectKeptBoundary, type BoundaryMessage } from "./select-kept-boundary";

/** 保留比例的唯一真源在 `select-kept-boundary.ts`；这里只再导出，别另起常量 */
export { RETAIN_RATIO, RETAIN_RATIO as HISTORY_RETAIN_RATIO } from "./select-kept-boundary";

/** 摘要模式（##442）：`model` = 模型读被压段产出结构化摘要；`self` = 只给指令、让模型自己去查 */
export const SummaryModeSchema = z
    .enum(["model", "self"])
    .describe(
        "压缩后如何告诉模型「前面那段没了」：" +
            "`model` = 先把被压掉那段交给模型压成结构化摘要（结论/改动/未完成/未决），摘要消息顶替该段（dsh / pi 的做法）；" +
            "`self` = 不做摘要，只注入一条固定指令（压缩事实 + 原文路径 + 检索方式 + 要产出什么），让模型自己去查——" +
            "两种形态用于对比效果，切换只改这一个字段",
    );

/**
 * 历史压缩的配置面 = **两项**。
 *
 * 不再有 token 绝对值：保留量是「窗口 × retainRatio」，窗口取不到 ⇒ 不压（不猜数）。
 */
export const HistoryLimitSchema = z.object({
    retainRatio: z
        .number()
        // 夹到 (0, 0.8)：≥ 触发线（缺省 0.8）时压完等于没压，等于配置写错 ⇒ 夹到 0.5 + 出声（见 auto-compact）
        .transform((v: number) => Math.min(0.5, Math.max(0.01, v)))
        .describe(
            `压缩后**保留**多少历史：模型窗口上限 × 本值（缺省 ${RETAIN_RATIO}）。` +
                "0.16 ⇒ 128k 窗口留 20k、256k 留 41k、1M 留 160k（与 dsh 同值）；" +
                "必须显著小于触发比例（`triggers.windowOverRatio`，缺省 0.8），否则压完立刻又超",
        ),
    /**
     * **模型窗口取不到时的兜底**（token）；缺省不填 = 不压（不猜数）。
     *
     * 为什么留这么一格：窗口上限的真源是模型目录（`contextLimitOf`），而自建/自托管模型的目录里
     * 常常没有 `contextLimit`（dsh 也是让 adapter 自己声明 `contextWindow`，不猜）。
     * **填了它 = 显式覆盖**（测试 / 自建模型 / 想让压缩更激进）；不填 = 走模型目录；
     * 两边都没有 = 不压（不猜数）。
     */
    windowTokens: z
        .number()
        .transform((v: number) => Math.max(0, Math.floor(v)))
        .optional()
        .describe("模型窗口上限（token）—— 显式覆盖；不填则取模型目录，两边都没有 ⇒ 不压（不猜数）"),
    summary: z
        .object({ mode: SummaryModeSchema })
        .describe("压缩后如何承接被压掉的内容（`model` 摘要 / `self` 让模型自己查）"),
});

export type HistoryLimit = z.infer<typeof HistoryLimitSchema>;

export const DEFAULT_HISTORY_LIMIT: HistoryLimit = {
    retainRatio: RETAIN_RATIO,
    summary: { mode: "model" },
};

/**
 * 宽松归一：手写 / LLM 写的配置可能缺字段、给成越界值、或带着旧字段名。
 *
 * 旧形状（`limitTokens` 数字 / `summary.enabled` 布尔）**忽略**并回落缺省：
 * 保留量现在是窗口比例，没有可折算的等价物（用户 2026-10-27：「limitTokens 这个是以前的」）。
 * 出声由调用方负责（`isCompleteHistoryLimit` 为 false 时给一条 warning）。
 */
export function normalizeHistoryLimit(raw: unknown): HistoryLimit {
    const src = (raw ?? {}) as Record<string, unknown>;
    const r = src["retainRatio"];
    const retainRatio =
        typeof r === "number" && Number.isFinite(r) && r > 0
            ? Math.min(0.5, Math.max(0.01, r))
            : DEFAULT_HISTORY_LIMIT.retainRatio;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    // 旧 `summary.enabled`（布尔）不再有「关」这一档：压掉必须有替身，缺省 mode = model
    const mode = sum?.["mode"] === "self" ? "self" : sum?.["mode"] === "model" ? "model" : undefined;
    const summary = { mode: (mode ?? DEFAULT_HISTORY_LIMIT.summary.mode) as HistoryLimit["summary"]["mode"] };
    const w = src["windowTokens"];
    const windowTokens = typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.floor(w) : undefined;
    return { retainRatio, ...(windowTokens === undefined ? {} : { windowTokens }), summary };
}

/**
 * 配置是否**完整**（`retainRatio` 是正数、`summary.mode` 合法）。只用来**出声**：
 * 不完整照样能用（`normalizeHistoryLimit` 补缺省），但要告诉用户「你写的那份没照形状」。
 */
export function isCompleteHistoryLimit(raw: unknown): boolean {
    const src = (raw ?? {}) as Record<string, unknown>;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    return (
        typeof src["retainRatio"] === "number" && (sum?.["mode"] === "model" || sum?.["mode"] === "self")
    );
}

/**
 * token 粗估（CJK 感知）：CJK 码点 1 token/字，其余 4 字符 1 token。
 *
 * ⚠️ 与 `compaction.ts::estimateTokens`（字节 / 4）**不是同一个口径**，两者并存是已知遗留：
 * 本函数喂历史压缩边界（要与窗口比例比，中文不能低估 4 倍）；那边喂 inputGate / preflight。
 */
export function estimateTokensOf(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0) ?? 0;
        // CJK 统一表意文字（含扩展 A/B）、假名、谚文、全角标点：按 1 token / 字
        if (
            (c >= 0x3000 && c <= 0x30ff) || // 全角标点 / 假名
            (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
            (c >= 0x4e00 && c <= 0x9fff) || // 基本区
            (c >= 0xac00 && c <= 0xd7af) || // 谚文
            (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
            (c >= 0x20000 && c <= 0x3ffff) // 扩展 B 及以后
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
}

export interface CompactableRange {
    /** 切点的消息下标（**这条及之后保留**；它之前全部丢弃） */
    cut: number;
    /** 本次丢掉的消息条数 */
    dropped: number;
}

export interface SelectRangeOpts {
    /** 每条消息的 token 成本（缺省 = 内容 JSON 的 CJK 感知粗估） */
    costOf?: (m: CompactableMessage, index: number) => number;
}

/**
 * **core 侧的适配层**：把消息序列喂给唯一判据 `selectKeptBoundary`，再换算成 core 的 `{cut, dropped}`。
 *
 * @param retainTokens 保留量 = `窗口 × retainRatio`
 * @param triggerTokens 触发线 = `窗口 × windowOverRatio`（压完仍超它 ⇒ 不压）
 * @returns `null` = 没有可丢的（什么都没发生，不写边界）
 */
export function selectCompactableRange(
    all: readonly CompactableMessage[],
    retainTokens: number,
    triggerTokens: number,
    opts: SelectRangeOpts = {},
): CompactableRange | null {
    if (all.length === 0 || !(retainTokens > 0) || !(triggerTokens > retainTokens)) return null;
    const cost = opts.costOf ?? ((m: CompactableMessage) => estimateTokensOf(JSON.stringify(m.content ?? "")));
    const msgs: BoundaryMessage[] = all.map((m, i) => ({ tokens: cost(m, i), user: m.role === "user" }));
    const boundary = selectKeptBoundary(msgs, retainTokens, triggerTokens);
    if (!hasDropped(boundary)) return null;
    return { cut: boundary.cut, dropped: boundary.dropped };
}

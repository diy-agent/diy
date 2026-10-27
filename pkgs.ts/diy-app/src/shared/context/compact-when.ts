// src/shared/context/compact-when.ts
// 🎯 「什么时候会压」的文案真源（##442 最大精简）。
//
// 现行判据（真源 `main/services/local-agent.ts::appliedHistoryRange`）：
//   ① 自动：最后一步实测用量 ≥ 触发线（窗口 − max(10%, 16k)）⇒ 压；窗口未知 ⇒ 不压。
//   ② 已有边界：保留段 < 触发线 ⇒ 复用；≥ 触发线 ⇒ 再算一次（切点只前进）。
//   ③ 每步投递：按已落盘边界切，不重算。
//   ④ 手动：随时可用；无视触发线与内容大小，至少丢一步（##442 用户 2026-10-27 选 C）。
//
// 没有 mode / 三触发器 / limitTokens / 保头 / 事后配平。
// 纯函数：禁止 import node:*。

import { triggerTokensOf } from "./select-kept-boundary";

/** 已落盘的压缩边界（turns.jsonl 的 compaction entry，只取展示需要的三项） */
export interface CompactWhenBoundary {
    at: string;
    dropped: number;
    /** 那一次生效的保留量（token） */
    limitTokens: number;
}

export interface CompactWhenInput {
    /** 保留量（token = 窗口 × 0.16，固定） */
    limitTokens: number;
    /** 已落盘边界；null = 从没压过（投递 = 全量） */
    boundary: CompactWhenBoundary | null;
    /** 上次真发投递的历史 ≈ token；null = 没记录 */
    retainedTokens: number | null;
    /** 最后一步实测 token；null = 没有实测 */
    lastStepTokens: number | null;
    /** 模型窗口上限；null = 未知 */
    windowLimit: number | null;
}

export interface CompactWhenRow {
    key: "first" | "retained" | "reuse" | "manual";
    label: string;
    state: "on" | "off" | "manual";
    text: string;
    hint: string;
}

export function fmtTtl(ms: number | null): string {
    if (ms == null) return "无实测时长";
    if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
}

export function fmtTokens(n: number): string {
    return `${Math.round(n).toLocaleString()} tok`;
}

export function windowRatio(lastStepTokens: number | null, windowLimit: number | null): number | null {
    if (lastStepTokens == null || windowLimit == null || windowLimit <= 0) return null;
    return Math.round((lastStepTokens / windowLimit) * 1000) / 10;
}

export function fmtStamp(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 触发线：窗口 − max(10%, 16k)；窗口未知 ⇒ null */
function triggerOf(windowLimit: number | null): number | null {
    return windowLimit != null && windowLimit > 0 ? triggerTokensOf(windowLimit) : null;
}

export function compactWhenRows(i: CompactWhenInput): CompactWhenRow[] {
    const b = i.boundary;
    const trigger = triggerOf(i.windowLimit);
    const triggerText = trigger == null ? "窗口未知 ⇒ 不压" : fmtTokens(trigger);
    const used = i.lastStepTokens == null ? "无实测" : fmtTokens(i.lastStepTokens);

    const firstText =
        trigger == null
            ? "模型窗口未知 ⇒ 不自动压（不猜数）；可手动压"
            : b
              ? `已有边界（${fmtStamp(b.at)} 写的，丢 ${b.dropped} 条）⇒ 自动这条路只在保留段再顶到触发线时走`
              : `最后一步用量 ${used} / 触发线 ${triggerText} ⇒ 到线就压`;

    const retainedText =
        trigger == null
            ? "窗口未知，无法判断"
            : i.retainedTokens == null
              ? `触发线 ${triggerText} · 保留段还没有实测（等下一次真发记进账本）`
              : `保留段 ${fmtTokens(i.retainedTokens)} / 触发线 ${triggerText} ⇒ ${
                    i.retainedTokens >= trigger
                        ? "下一步再压一次"
                        : `再涨 ${fmtTokens(trigger - i.retainedTokens)} 才会再压`
                }`;

    return [
        {
            key: "first",
            label: "自动触发",
            state: trigger == null ? "off" : b ? "off" : "on",
            text: firstText,
            hint: "判据：最后一步实测用量 ≥ 窗口 − max(10%, 16k)。窗口取不到 ⇒ 不压（不猜数）。",
        },
        {
            key: "retained",
            label: "保留段再顶到触发线",
            state: b ? "on" : "off",
            text: retainedText,
            hint:
                "只看保留段自己（不把已丢的段算进来）；保留量固定 = 窗口 × 0.16，" +
                "所以压完到触发线之间还有很大的增长余量，不会每步重压。",
        },
        {
            key: "reuse",
            label: "每步投递",
            state: "on",
            text: "按已落盘边界切：切点固定，新增长只追加到尾部，每步不重算",
            hint: "投递每步都发生；压缩只在事件时发生（改边界）。",
        },
        {
            key: "manual",
            label: "手动",
            state: "manual",
            text: "随时可用：无视触发线与内容大小，至少丢一步",
            hint: "##442 用户 2026-10-27 选 C：手动压缩用同一套选段，只把两条「不压」判据拿掉。",
        },
    ];
}

/** 自动压缩与投递的关系 —— 一句话 */
export function autoCompactSentence(): string {
    return (
        "自动压缩：最后一步用量到触发线（窗口 − max(10%, 16k)）就压；" +
        "另记一条审计（compact.jsonl），**不改投递切点** —— 投递只认已落盘的边界。"
    );
}

export function compactWhenSummary(i: CompactWhenInput): string {
    const where = i.boundary ? `已压过（${fmtStamp(i.boundary.at)}，丢 ${i.boundary.dropped} 条）` : "还没压过";
    return `历史 ${where} · 保留 ${fmtTokens(i.limitTokens)}（窗口 × 0.16）`;
}

/** 「压成什么样」的一句话 */
export function compactResultSentence(limitTokens: number): string {
    return (
        `保留量 ${fmtTokens(limitTokens)}（窗口 × 0.16）：从最后一条往前累加，装够就停；` +
        "切点往前挪到最近的 user 消息（call/result 永不拆）。没有保头、没有事后配平、没有绝对 token 上限；" +
        "边界只在压缩事件时算一次，之后每步只按它切。"
    );
}

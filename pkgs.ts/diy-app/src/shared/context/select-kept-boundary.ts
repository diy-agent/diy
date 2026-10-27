// src/shared/context/select-kept-boundary.ts
// 🎯 压缩边界 = **一条保留比例 + 一条切点规则**（##442，2026-10-27 最大精简）。
//
// 全部算法：
//   ① 从最后一条往前累加 token，装到 ≥ `W × 0.16` 为止；
//   ② 切点往前挪到最近的 **user 消息**（消息边界 ⇒ call/result 不可能被拆）；
//   ③ 压完仍超触发线 ⇒ 不压（空转判据；手动 force = 跳过它）。
//
// 触发线 = `W − max(W × 0.1, 16000)`（零旋钮：给输出/摘要留 10%，小窗口至少留 16k）。
//
// 删掉的东西（别再长回来）：
//   · `HEAD_KEEP_TOKENS = 600` 保头 —— dsh / opencode / pi 都没有；它让边界锚点永远卡在第 1 轮。
//   · `balanceCut` / 事后配平 —— 三家都是「选的时候就只许落在合法位置」。
//   · `limitTokens` 绝对值 / `MIN=4000` 夹取 / `RETAIN_RATIO=0.5` 那层乘法。
//   · `windowOverRatio` 配置 —— 触发式是派生量，不需要用户填。
//
// 纯函数：禁止 import node:*（core / UI / 单测共用同一份判据）。

/** 边界计算只需要「多大」与「这条是不是 user」 */
export interface BoundaryMessage {
    /** 该条消息的估算 token 数 */
    tokens: number;
    /** 这条是不是 user 消息（切点只许落在这里） */
    user?: boolean;
}

export interface KeptBoundary {
    /** 保留区起点下标（这条及之后保留；它之前全部丢弃） */
    cut: number;
    /** 丢掉的消息条数（= `cut`） */
    dropped: number;
    /** 保留段实际的 token 数（可能 > 保留量：一条消息/一轮本身超大时） */
    retainedTokens: number;
    /** `none` = 什么都没丢 · `drop` = 真的丢了 `dropped` 条 */
    kind: "none" | "drop";
}

/** 压完保留多少：窗口 × 0.16（dsh 同值；128k→20k、256k→41k、1M→160k） */
export const RETAIN_RATIO = 0.16;

/** 触发线预留：窗口的 10% 或 16k token，取大者（零旋钮） */
export const TRIGGER_RESERVE_RATIO = 0.1;
export const TRIGGER_RESERVE_MIN = 16_000;

/** 触发线 = 窗口 − max(10%, 16k) */
export function triggerTokensOf(windowTokens: number): number {
    if (!(windowTokens > 0)) return 0;
    return Math.max(0, Math.floor(windowTokens - Math.max(windowTokens * TRIGGER_RESERVE_RATIO, TRIGGER_RESERVE_MIN)));
}

/** 保留量 = 窗口 × 0.16 */
export function retainTokensOf(windowTokens: number): number {
    if (!(windowTokens > 0)) return 0;
    return Math.max(1, Math.floor(windowTokens * RETAIN_RATIO));
}

const none = (): KeptBoundary => ({ cut: 0, dropped: 0, retainedTokens: 0, kind: "none" });

/**
 * 算保留边界（**唯一判据**）。
 *
 * @param retainTokens 保留量 = `W × 0.16`
 * @param triggerTokens 触发线 = `W − max(10%W, 16k)`；压完仍超它 ⇒ 不压
 * @param opts.force 手动压缩：跳过「压完仍超触发线」这条（内容再小也要真丢东西）
 */
export function selectKeptBoundary(
    messages: readonly BoundaryMessage[],
    retainTokens: number,
    triggerTokens: number,
    opts: { force?: boolean } = {},
): KeptBoundary {
    const n = messages.length;
    if (n === 0 || !(retainTokens > 0)) return none();

    // ① 从尾往前累加到 ≥ 保留量
    let acc = 0;
    let i = n - 1;
    for (; i >= 0; i--) {
        acc += messages[i]!.tokens;
        if (acc >= retainTokens) break;
    }
    // ② 切点往前挪到最近的 user
    let cut = -1;
    for (let j = i; j >= 0; j--) {
        if (messages[j]!.user) {
            cut = j;
            break;
        }
    }
    if (cut <= 0) return none();

    let retained = 0;
    for (let j = cut; j < n; j++) retained += messages[j]!.tokens;
    // ③ 压完仍超触发线 ⇒ 不压（手动 force 跳过）
    if (!opts.force && retained >= triggerTokens) return none();

    return { cut, dropped: cut, retainedTokens: retained, kind: "drop" };
}

/** 这次是否真的丢了东西（= 是不是一次压缩事件） */
export const hasDropped = (b: KeptBoundary): boolean => b.kind === "drop";

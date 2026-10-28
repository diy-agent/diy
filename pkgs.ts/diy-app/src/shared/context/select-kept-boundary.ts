// src/shared/context/select-kept-boundary.ts
// 🎯 压缩边界的**唯一判据**（##442，2026-10-27 用户拍板「最大精简」）。
//
// ── 算法（只有这三步）──
//   ① 从最后一条往前累加 token，装到 ≥ `W × 0.16` 为止；
//   ② 切点往前挪到最近的 **user 消息**；有 turn 字段时再吸附到**轮首**
//      （消息边界 + 轮首 ⇒ tool call/result 不可能被拆，消息级 ≡ 轮级）；
//   ③ 压完仍超触发线 ⇒ 不压（空转判据；手动 force = 跳过它）。
//
// 触发线 = `W − max(W × 0.1, 16000)`（零旋钮：给输出/摘要留 10%，小窗口至少留 16k）。
//
// ── 来源与选择依据（2026-10-26/27 调研 dsh / opencode v2 / pi）──
//   · 保留比例 0.16：dsh `compaction-basic` 的 DEFAULT_RETAIN_RATIO；128k→20k、
//     256k→41k、1M→160k，正好落在 opencode 固定 15k / pi 固定 20k 的小窗口量级。
//   · 触发式 `W − max(10%,16k)`：opencode v2 的 `W − max(10%,16k)`（pi 是 W−16384），
//     比 dsh 的 `min(0.8W,...)` 更小窗口友好；用户 2026-10-27 选「零旋钮」，故不配置。
//   · 切点落 user/轮首：三家共识「选的时候就只许落在合法位置」（dsh 配对断言 /
//     opencode 吸附 user / pi 切点白名单）；diy 用 turnId，比 opencode 更精确。
//   · 不保头：dsh/opencode/pi 都没有。保头会让 `keptFromTurnId` 永远指向第 1 轮，
//     边界锚点无法前进（##266 实测）。
//   · 不做事后配平：事后补一个方向就会漏另一个方向（##444 `Tool result is missing`）。
//   · 固定 0.16 而不是 0.5：0.5 在 128k 上只腾出 43%（每 12 步压一次），1M 上留 500k
//     原文（浪费）；用户 2026-10-27 明确「0.16 按 dsh 来」。
//
// ── 调用链（改之前先看这里）──
//   selectKeptBoundary（本文件） → history-limit.selectCompactableRange（适配）
//   → local-agent.appliedHistoryRange（只有 triggered 事件才写 turns 边界）
//   → local-agent.compact（审计/内存态） → preflight（0.8W 最后保险）
//   边界落盘在 turns.jsonl v3（retainTokens/windowTokens/cut.turnId/ref）。
//
// ── 已知未完成（别误以为已做）──
//   · `summary.mode: model` 的**自动摘要生成**还没接进压缩事务；当前摘要为空时
//     通知会明确说「model 模式摘要未生成」，不要把它当 self。
//   · system + runtime 体积上限（dsh 65536 字节 / pi 不限）只写在注释，未改行为。
//   · step 7：turns 唯一边界、compact-state/日志纯审计、segment.json 尚未收敛。
//
// 纯函数：禁止 import node:*（core / UI / 单测共用同一份判据）。

/** 边界计算只需要「多大」与「这条是不是 user」 */
export interface BoundaryMessage {
    /** 该条消息的估算 token 数 */
    tokens: number;
    /** 这条是不是 user 消息（切点只许落在这里） */
    user?: boolean;
    /** 属于哪一轮（有它时切点必须落在**轮首**，保证消息级 ≡ 轮级） */
    turn?: string;
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
    // ② 切点往前挪到最近的 user；有 turn 时再吸附到**轮首**（同轮插话不单独切）
    let cut = -1;
    for (let j = i; j >= 0; j--) {
        if (messages[j]!.user) {
            cut = j;
            break;
        }
    }
    if (cut <= 0) return none();
    const cutTurn = messages[cut]!.turn;
    if (cutTurn) {
        let start = cut;
        while (start > 0 && messages[start - 1]!.turn === cutTurn) start--;
        // 轮首通常是开场 user；万一不是，退到该轮第一条 user
        for (let j = start; j <= cut; j++) {
            if (messages[j]!.user) {
                start = j;
                break;
            }
        }
        cut = start;
        if (cut <= 0) return none();
    }

    let retained = 0;
    for (let j = cut; j < n; j++) retained += messages[j]!.tokens;
    // ③ 压完仍超触发线 ⇒ 不压（手动 force 跳过）
    if (!opts.force && retained >= triggerTokens) return none();

    return { cut, dropped: cut, retainedTokens: retained, kind: "drop" };
}

/** 这次是否真的丢了东西（= 是不是一次压缩事件） */
export const hasDropped = (b: KeptBoundary): boolean => b.kind === "drop";

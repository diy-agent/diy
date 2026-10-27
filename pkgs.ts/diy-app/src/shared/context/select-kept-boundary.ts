// src/shared/context/select-kept-boundary.ts
// 🎯 压缩边界 = **一个比例 + 一条切点规则**（##442，2026-10-27 向 dsh 看齐）。
//
// 全部算法就是这两句：
//   ① 从最后一条往前累加 token，装到 ≥ `window × RETAIN_RATIO` 为止；
//   ② 切点往前挪到最近的 **user 消息**（轮首 / 插话，都是消息边界）—— 配对靠结构保证：
//      assistant 的 tool-call 之后紧跟它的 result，而 call 在本条、result 在后面的消息里，
//      切点落在 user 上 ⇒ 整组 call/result 必然一起留在保留段，**孤立 call 物理上不可能**。
//
// 删掉的东西（别再长回来）：
//   · `HEAD_KEEP_TOKENS = 600` 保头 —— dsh / opencode / pi 三家都没有。它的真正代价不是那 600 token：
//     保头让保留区变成「头 + 尾」两段，于是 `keptFromTurnId` 永远指向第 1 轮 ⇒ 边界锚点永不前进
//     （##266 实测：`dropped` 卡在 14584、历史一路长到 168k）。用户开局那句话由摘要/自取指令承接。
//   · `balanceCut` / `balanceHeadPairing` / `balancePairing` 事后配平 —— 三家都是**选的时候就只许
//     落在合法位置**（dsh 断言配对、opencode 吸附 user、pi 切点白名单）。事后补 = 补漏一个方向就炸
//     （##444 的 `Tool result is missing` 就是这么来的）。
//   · `MIN_HISTORY_LIMIT_TOKENS = 4000` 下限、`limitTokens` 绝对值、`RETAIN_RATIO = 0.5` 那一层乘法
//     —— 「固定 token 上限」与「窗口比例」两套口径同时活着，`76800` 这种数既不是比例也不是用户口径。
//
// ⚠️ 待办（用户 2026-10-27：先只标注，不改行为）：system + runtime 的**体积上限**。
//   dsh 给 AGENTS.md 链 65,536 字节预算（先省略宽泛文件、最后才截断最具体的，且留可见标记）；
//   pi 完全不限（全量内联进 system）。diy 现在也是 pi 式，实测 24k、历史到过 100k。
//   若 `system + runtime > 窗口 × 0.5`，压缩再怎么切也救不回来（能压的只有历史）——
//   那时该报「上下文预算被 body/facts 吃掉」而不是硬压。这条以后再落。
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
    /** 丢掉的消息条数（= `cut`，显式给出，调用方别用下标算式推） */
    dropped: number;
    /** 保留段实际的 token 数（可能 > `retainTokens`：一条消息/一轮本身超大时） */
    retainedTokens: number;
    /** `none` = 什么都没丢（不写边界）· `drop` = 真的丢了 `dropped` 条 */
    kind: "none" | "drop";
}

/**
 * **保留比例 = 0.16**，乘「模型窗口上限」（dsh `DEFAULT_RETAIN_RATIO` 同值）。
 *
 * 为什么是 0.16 而不是 0.5（用户 2026-10-27 拍板「按 dsh 来，他们是做模型的」）：
 * 三档窗口跑出来的绝对量与另两家的固定值吻合 —— 128k → 20k（opencode 固定 15k、pi 固定 20k）、
 * 256k → 41k、1M → 160k。而 0.5 在 128k 上只腾出 43%（每 12 步压一次），在 1M 上留 500k 原文（浪费）。
 */
export const RETAIN_RATIO = 0.16;

/**
 * 「不压」的返回值：`cut = 0` **保留一切**（不是 `cut = n` —— 那表示"一条都不留"）。
 * 预览（`compact-example`）把 `i >= cut` 当"保留"，所以这里的 0 必须是"全都留"，
 * 否则「样例比保留量还小」时会显示成"全丢"（##442 单测实测踩到）。
 */
const none = (): KeptBoundary => ({ cut: 0, dropped: 0, retainedTokens: 0, kind: "none" });

/**
 * 算保留边界（**唯一判据**）。
 *
 * @param messages 消息序列（只要 `tokens` 与 `user`）
 * @param retainTokens 保留量 = `窗口 × RETAIN_RATIO`
 * @param triggerTokens 触发线（= `窗口 × windowOverRatio`）。**压完仍超它 ⇒ 不压**：
 *        压了也没把占用降下来，只会白写一条账、白破一次前缀缓存（用户口径「压得勤可以，空转不行」）。
 *        尾部一坨巨型工具结果时就是这个分支——dsh/pi 同样「选不出（有意义）的区间就不压」。
 */
export function selectKeptBoundary(
    messages: readonly BoundaryMessage[],
    retainTokens: number,
    triggerTokens: number,
): KeptBoundary {
    const n = messages.length;
    if (n === 0 || !(retainTokens > 0)) return none();

    // ① 从尾往前累加到 ≥ 保留量（`i` = 这一轮累加到的位置）
    let acc = 0;
    let i = n - 1;
    for (; i >= 0; i--) {
        acc += messages[i]!.tokens;
        if (acc >= retainTokens) break;
    }
    // ② 切点往前挪到最近的 user 消息（消息边界 ⇒ call/result 不拆）
    let cut = -1;
    for (let j = i; j >= 0; j--) {
        if (messages[j]!.user) {
            cut = j;
            break;
        }
    }
    // 找不到 user 边界（整段没有 user）/ 切点落在开头 = 没有可丢的东西
    if (cut <= 0) return none();

    let retained = 0;
    for (let j = cut; j < n; j++) retained += messages[j]!.tokens;
    // ③ 压完仍超触发线 ⇒ 不压（空转判据）
    if (retained >= triggerTokens) return none();

    return { cut, dropped: cut, retainedTokens: retained, kind: "drop" };
}

/** 这次是否真的丢了东西（= 是不是一次压缩事件）。判据只看显式状态，不推下标。 */
export const hasDropped = (b: KeptBoundary): boolean => b.kind === "drop";

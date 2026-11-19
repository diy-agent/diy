// snapshot.ts —— 段首 system 快照的**判据**（纯函数）：复用上一步真发的 system，还是重建。
//
// 为什么在机制包里（2026-11-19 从 `apps/diy-app/src/shared/context/segment-snapshot.ts` 搬来）：
// 这条规则是**缓存契约**，不属于某个宿主。留在宿主里，每接一个新宿主（bot / diy2）就得
// 复刻一遍 —— 那正是「测试都过、缓存还是失效」的结构性来源。
//
// ── 铁律（用户 2026-10-31 口径，原文）──
//   「一旦发出 role:system 消息后，**啥变都不要更新 history**，除非压缩才会真重建 history。」
//   即：system 与历史消息是**段内不可变的**；变量树再怎么变，都只以 user 侧的变量增量补丁发出
//   （`step-delta.ts`）。
//
// ── 什么时候必须重建（只有这四种原因）──
//   · `first`           还没有快照（首轮 / 会话清零）
//   · `segment-changed` 压缩换了段（`boundary.at` ≠ 上一步快照的 `compactAt`）
//   · `legacy-format`   老格式快照（没有顶格 `vars:`）
//   · `reuse`           （不是重建）逐字复用
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

/**
 * 这段文本的**顶层**（顶格）键里有 `vars:` 吗。
 *
 * ⚠️ 判据是 `/^vars:/m`（允许 `vars: {}`），**不是** `line === "vars:"`：
 * 变量树为空时信封里落的是 `vars: {}` —— 逐行相等判据会把它当成"老格式"，
 * 于是**每一轮都重建 system**（缓存全废）。
 * help 段里的同名说明是**缩进**的，`^` 不会命中。
 */
export function hasTopLevelVars(text: string): boolean {
    return /^vars:/m.test(text);
}

/** 为什么用了这一份（复用 / 三种重建原因）—— 调用点据此留痕，别让重建悄悄发生 */
export type SnapshotReason = 'reuse' | 'first' | 'segment-changed' | 'legacy-format';

/** 段首快照的输入（全部由调用方解析好；本模块不碰盘） */
export interface SegmentSnapshotInput {
    /** 本轮现算的 system 原文 */
    liveText: string;
    /** 上一步真发落盘的 system 原文（没有 = 首轮 / 老任务没记） */
    lastText?: string | null;
    /** 上一步快照所属的压缩段（落盘 `compactAt`） */
    lastCompactAt?: string | null;
    /** 当前的压缩段（没有边界 = 还没压过） */
    boundaryAt?: string | null;
}

/** 判据本体：返回该用的文本 + 原因 */
export function segmentSystemSnapshotOf(input: SegmentSnapshotInput): { text: string; reason: SnapshotReason } {
    const { liveText, lastText } = input;
    const lastCompactAt = input.lastCompactAt ?? null;
    const boundaryAt = input.boundaryAt ?? null;
    if (!lastText) return { text: liveText, reason: 'first' };
    // 压缩边界 = 新段：段首必须换成现状（旧段首描述的是已被压缩掉的那段世界）
    if (lastCompactAt !== boundaryAt) return { text: liveText, reason: 'segment-changed' };
    // 老格式：变量树的分段不是现在这一份，不能当新段首用
    if (!hasTopLevelVars(lastText)) return { text: liveText, reason: 'legacy-format' };
    return { text: lastText, reason: 'reuse' };
}

/** 本步该用哪份 system 原文（只要文本） */
export function segmentSystemTextOf(input: SegmentSnapshotInput): string {
    return segmentSystemSnapshotOf(input).text;
}

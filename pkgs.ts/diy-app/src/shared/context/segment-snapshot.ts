// src/shared/context/segment-snapshot.ts
// 🎯 段首 system 快照的**判据**（纯函数）：这一步该复用上一步真发的 system 原文，还是重建。
//
// ── 铁律（用户 2026-10-31 口径，原文）──
//   「一旦发出 role:system 消息后，**啥变都不要更新 history**，除非压缩才会真重建 history。」
//   即：system 与历史消息是**段内不可变的**；变量树再怎么变，都只以 user 侧的控制增量补丁发出
//   （`step-delta.ts`）—— 所以 `~/.diy/context.yaml` 把哪些单元划进 system，**不影响**缓存命中：
//   那些单元后来变了，也只是补在 `role:user` 的 `system:` 段里，不会重写已发出的 system。
//   （旧判据"放易变项进 system ⇒ 每轮砸缓存"是 ##426 时期的事实，那时还没有本模块。）
//
// ── 为什么必须复用（##442 / ##486）──
//   前缀缓存按**逐字节**匹配。system 是请求的第一块，它的字节只要变一个字符，它之后的
//   整段历史就全部按 cache miss 计费（##266 实测：390k 上下文的会话，一次冷启动
//   385k 非缓存输入 ≈ $0.056 —— 那一天 4 次冷启动占全天成本 55%）。
//   而变量树里的 `self`（窗口占用 / 上一步花费）**每步都在变**：若每轮都把变量树重算进
//   system，缓存永远命不中。
//
// ── 什么时候必须重建（只有这四种原因）──
//   · `first`           还没有快照（首轮 / 会话清零）
//   · `segment-changed` 压缩换了段（`boundary.at` ≠ 上一步快照的 `compactAt`）—— 段首已经描述
//                       的是被压掉的那段世界，留着它模型会按旧状态干活
//   · `legacy-format`   老格式快照（##442 之前的 system 里没有顶格 `runtime:`）—— 那种形状里
//                       变量树只有 system 一份，不能拿来当"两棵树都在 system"的新段首
//   · `reuse`           （不是重建）逐字复用
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

/**
 * 这段文本的**顶层**（顶格）键里有 `runtime:` 吗。
 *
 * ⚠️ 判据是 `/^runtime:/m`（允许 `runtime: {}`），**不是** `line === "runtime:"`：
 * 用户把全部原子单元都划进 system 时，易变树为空，信封信封里落的是 `runtime: {}` ——
 * 旧的逐行相等判据会把它当成"老格式"，于是**每一轮都重建 system**（缓存全废）。
 * 实测：`buildDelivery(globals, 全部候选)` 的 system.text 顶格行就是 `runtime: {}`。
 *
 * help 段里也有一行 `runtime:`，但那是**缩进**的（`  runtime:`），`^` 不会命中。
 */
export function hasTopLevelRuntime(text: string): boolean {
    return /^runtime:/m.test(text);
}

/** 为什么用了这一份（复用 / 三种重建原因）—— 调用点据此留痕，别让重建悄悄发生 */
export type SnapshotReason = "reuse" | "first" | "segment-changed" | "legacy-format";

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
    if (!lastText) return { text: liveText, reason: "first" };
    // 压缩边界 = 新段：段首必须换成现状（旧段首描述的是已被压缩掉的那段世界）
    if (lastCompactAt !== boundaryAt) return { text: liveText, reason: "segment-changed" };
    // 老格式（##442 之前）：变量树只有 system 一份，不能当新段首用
    if (!hasTopLevelRuntime(lastText)) return { text: liveText, reason: "legacy-format" };
    return { text: lastText, reason: "reuse" };
}

/**
 * 本步该用哪份 system 原文（只要文本）。
 *
 * 返回 `liveText` = 重建（新段首）；返回 `lastText` = **逐字复用**（缓存命中的前提）。
 * 调用方据「返回的是否等于 liveText」判断要不要补跨轮增量。
 */
export function segmentSystemTextOf(input: SegmentSnapshotInput): string {
    return segmentSystemSnapshotOf(input).text;
}

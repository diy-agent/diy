// src/shared/context/request-preflight.ts
// 🎯 发请求**前**的 token 预检（##406 刀 2 后半）—— 纯函数，禁止 import node:*
//
// ── 它补的是哪一段 ──
//   · 装配层的硬上限（`assemblyHardCapBytes`，投递侧 `selectHistoryByCut` 的 `cap` 分支）管的是**历史**：
//     装完量 `keptBytes`，超了就降级 —— 但它不知道 system / tools 有多大，也不知道窗口。
//   · 本模块把「system + tools + messages 合起来」折算成 token，跟**模型窗口**比，
//     越线（> 80%）就在发之前处理：先按剩余额度重装一次（能压就压），压不动才提示。
//
// 为什么必须有：##401 的会话死锁形态是「发出去 → 上游 400 → 用户再发「？」→ 同一个 400」，
// 每一轮都按全价付过一遍。**在发之前量一次**是唯一能避免这件事的位置。
//
// 口径：1 token ≈ 4 字节（与全仓同一个粗估口径 `estimateTokens`，无 tokenizer）。

import { estimateTokens } from "./compaction";

/** 拿不到模型窗口时，装配层硬上限的兜底（1 MiB） */
export const DEFAULT_ASSEMBLY_HARD_CAP_BYTES = 1024 * 1024;

/**
 * 装配后硬上限（字节）的**唯一判据**：模型窗口 token × 4；拿不到窗口时兜底 1 MiB。
 *
 * 为什么是「× 4」而不是 × 4 × 0.8：这个闸只负责「别再把 4.95 MB 原样发出去」——留出 20% 的余量是
 * **发请求前的 token 预检**（本文件其余部分）的职责，两处各管一段，别混成一个数。
 */
export function assemblyHardCapBytes(contextLimitTokens?: number): number {
    if (!contextLimitTokens || !Number.isFinite(contextLimitTokens) || contextLimitTokens <= 0) return DEFAULT_ASSEMBLY_HARD_CAP_BYTES;
    return Math.floor(contextLimitTokens) * 4;
}

/** 预检线：占窗口比例超过它就先压/提示（缺省 80%，留 20% 给输出与上游自己的模板开销） */
export const PREFLIGHT_RATIO = 0.8;

/** 预检输入（字节 + 可选 CJK 感知 token；本模块不碰对象、不碰 IO） */
export interface RequestEstimateInput {
    /** system 容器（信封全文）字节 */
    systemBytes: number;
    /** tools JSON 字节 */
    toolsBytes: number;
    /** 历史 messages（含尾部 runtime 信封）JSON 字节 */
    messagesBytes: number;
    /** 可选：三段各自的 CJK 感知 token（调用方有原文时传；缺省回落 bytes/4） */
    systemTokens?: number;
    toolsTokens?: number;
    messagesTokens?: number;
    /** 模型上下文窗口（token）；缺省/未知 ⇒ 不做判断（没有判据就不报警） */
    contextLimitTokens?: number | null;
}

/** 预检结果（判据与可观测量都在这里，调用点只管照着办） */
export interface RequestEstimate {
    /** 三段字节之和 */
    bytes: number;
    /** 折算 token（字节 / 4） */
    estTokens: number;
    /** 模型窗口（token）；null = 未知 */
    contextLimitTokens: number | null;
    /** 预检线（token）；null = 窗口未知 */
    thresholdTokens: number | null;
    /** 占窗口比例（0~1+）；null = 窗口未知 */
    ratio: number | null;
    /** **越过预检线**（窗口未知恒 false —— 说得出上限才算「已识别」，见 rule.err-triage.recognized） */
    over: boolean;
}

/** 量一份请求（纯算术；窗口未知时 `over` 恒 false） */
export function estimateRequest(i: RequestEstimateInput): RequestEstimate {
    const bytes = Math.max(0, i.systemBytes) + Math.max(0, i.toolsBytes) + Math.max(0, i.messagesBytes);
    const estTokens =
        Math.max(0, i.systemTokens ?? estimateTokens(i.systemBytes)) +
        Math.max(0, i.toolsTokens ?? estimateTokens(i.toolsBytes)) +
        Math.max(0, i.messagesTokens ?? estimateTokens(i.messagesBytes));
    const win = i.contextLimitTokens && i.contextLimitTokens > 0 ? Math.floor(i.contextLimitTokens) : null;
    if (win === null) return { bytes, estTokens, contextLimitTokens: null, thresholdTokens: null, ratio: null, over: false };
    const thresholdTokens = Math.floor(win * PREFLIGHT_RATIO);
    return { bytes, estTokens, contextLimitTokens: win, thresholdTokens, ratio: estTokens / win, over: estTokens > thresholdTokens };
}

/**
 * 「要压到预检线以内，历史最多还能占多少字节」。
 *
 * 推导：整份请求 ≤ 窗口 × 4 × `PREFLIGHT_RATIO`
 *       ⇒ 历史 ≤ 上式 − system − tools − 预留（runtime 信封、history 注记、摘要等）。
 * 预留缺省 8 KB（实测这些段落通常 1~3 KB，留 8 KB 是保守值）；结果为负 ⇒ 0
 * （**system + tools 本身已越线**，历史压到零也救不回来 —— 调用方据此拒发并提示）。
 */
export function tighterHistoryCapBytes(i: {
    contextLimitTokens: number;
    systemBytes: number;
    toolsBytes: number;
    reserveBytes?: number;
    /** 字节/token（缺省 4；中文 CJK 约 3，调用方用实测比例传） */
    bytesPerToken?: number;
}): number {
    const budget = Math.floor(i.contextLimitTokens * (i.bytesPerToken ?? 4) * PREFLIGHT_RATIO);
    return Math.max(0, budget - Math.max(0, i.systemBytes) - Math.max(0, i.toolsBytes) - (i.reserveBytes ?? 8 * 1024));
}

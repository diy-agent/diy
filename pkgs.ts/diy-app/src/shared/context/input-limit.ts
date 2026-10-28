// src/shared/context/input-limit.ts
// 🎯 「用户这一条消息有多长」的**发送前门禁**（##426 B）—— 纯函数，禁止 import node:*
//
// 为什么需要它：一条 300 KB 粘贴 = 单步输入 21.6 万 token、$0.03，**且此后每轮都要重带**
// （它在历史里）。用户只打了 17 个字，却替这一整段付了每一轮的钱。发送前是唯一能拦的位置。
//
// 三条口径（都由这里的纯函数定，UI / main 不许各算一份）：
//   · 字符数按 **code point** 数（`[...text].length`）：emoji / 中文都是一个字；UTF-16 的 `.length`
//     会把 emoji 数成 2，阈值就不准了。
//   · token 估算沿用全仓唯一的粗估口径 `estimateTokens`（字节 / 4，无 tokenizer）。
//   · 成本增量按**当前模型单价快照**估：整条按「非缓存输入」计价（新消息本来就不在缓存里）。
//
// ⚠️ 判据只看**本条用户消息**，不看历史累计 —— 历史累计归压缩策略（`auto-compact`），
// 两件事混成一个数会让「超长粘贴」和「会话变长」互相背锅。

import { estimateTokens } from "@diy/compact/compaction";

/** 缺省阈值：10 万字符（≈ 25k token；一般上下文窗口下这是「明显异常」的起点） */
export const DEFAULT_INPUT_LIMIT_CHARS = 100_000;

/** 转文件时消息体里给多少行开头（够模型判断"这是什么"，又不必重付全文） */
export const PASTE_HEAD_LINES = 20;

/** 一条用户消息的字符数（code point 口径，不是 UTF-16 code unit） */
export function countChars(text: string): number {
    let n = 0;
    for (const _ of text) n++;
    return n;
}

/** 一条用户消息的 UTF-8 字节数 */
export function byteLenOf(text: string): number {
    return new TextEncoder().encode(text).length;
}

export interface InputGateInput {
    /** 用户本条消息原文 */
    text: string;
    /** 阈值（字符数）；`context.yaml` 的 `inputLimitChars` */
    limitChars: number;
    /** 当前模型上下文窗口（token）；未知 → null（窗口占用率给不出，不编） */
    contextLimitTokens?: number | null;
    /** 当前窗口占用（最后一步的总输入 + 总输出）；没有历史 → null */
    windowTokens?: number | null;
    /** 非缓存输入单价（$ / 1M token）；无价目 → null */
    inputRatePerM?: number | null;
}

export interface InputGate {
    /** 超过阈值（唯一判据；false 时 UI 必须零变化） */
    over: boolean;
    /** 本条字符数 */
    chars: number;
    /** 本条字节数 */
    bytes: number;
    /** 折算 token（字节 / 4，与全仓同口径） */
    estTokens: number;
    /** 阈值（字符数），回显用 */
    limitChars: number;
    /** 预计成本增量（$）；无价目 → null（**不可测 ≠ 0**：不许画成 $0） */
    costIncrement: number | null;
    /** 窗口占用分子（最后一步总输入 + 总输出）；未知 → null */
    windowTokens: number | null;
    /** 窗口上限；未知 → null */
    contextLimitTokens: number | null;
    /** 加上本条之后的窗口占用率（0~1+）；窗口未知 → null */
    windowRatio: number | null;
}

/** 量一条消息（纯算术；窗口 / 价目未知时对应字段给 null，绝不编一个数） */
export function inputGate(i: InputGateInput): InputGate {
    const chars = countChars(i.text);
    const bytes = byteLenOf(i.text);
    const estTokens = estimateTokens(bytes);
    const limit = Number.isFinite(i.limitChars) && i.limitChars > 0 ? Math.floor(i.limitChars) : DEFAULT_INPUT_LIMIT_CHARS;
    const win =
        i.contextLimitTokens != null && Number.isFinite(i.contextLimitTokens) && i.contextLimitTokens > 0
            ? Math.floor(i.contextLimitTokens)
            : null;
    const used =
        i.windowTokens != null && Number.isFinite(i.windowTokens) && i.windowTokens >= 0 ? i.windowTokens : null;
    const rate =
        i.inputRatePerM != null && Number.isFinite(i.inputRatePerM) && i.inputRatePerM >= 0 ? i.inputRatePerM : null;
    return {
        over: chars > limit,
        chars,
        bytes,
        estTokens,
        limitChars: limit,
        costIncrement: rate === null ? null : (estTokens * rate) / 1_000_000,
        windowTokens: used,
        contextLimitTokens: win,
        windowRatio: win === null ? null : ((used ?? 0) + estTokens) / win,
    };
}

/**
 * 「转文件发送」的消息体：**路径 + 前 N 行 + 总行数/字节数**。
 *
 * 为什么不直接给路径：模型读文件要额外一次工具往返（还容易读错行）；给前 20 行让它
 * 一眼看出这是什么，需要细节时再按路径取。总行数 / 字节数是"这文件有多大"的判据。
 */
export function pasteFileMessage(i: { path: string; text: string; headLines?: number }): string {
    const head = Math.max(1, i.headLines ?? PASTE_HEAD_LINES);
    const lines = i.text.split("\n");
    // 末尾换行不算"多一行"：`"a\n"` 是 1 行，不是 2 行
    const totalLines = i.text.length === 0 ? 0 : i.text.endsWith("\n") ? lines.length - 1 : lines.length;
    const shown = lines.slice(0, head);
    const truncated = totalLines > head;
    const body = [
        `内容已转存为文件：${i.path}`,
        `总行数：${totalLines}；字节数：${byteLenOf(i.text)}（本条消息不再携带全文）`,
        "",
        `前 ${Math.min(head, totalLines)} 行：`,
        ...shown.slice(0, head),
    ];
    if (truncated) body.push(`…（余下 ${totalLines - head} 行见文件）`);
    return body.join("\n");
}

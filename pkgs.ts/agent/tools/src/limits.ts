// limits.ts —— 工具输出的**唯一预算**（单条工具结果进模型前最多能有多大）
//
// 为什么单独一个文件（2026-11-27 用户裁）：以前一处一个数 —— read 100KB、投递层 50KB、
// run_code 日志 64KB / 返回值 32KB、job tail 16KB。同一个问题（「这条输出多大算大」）
// 有四个答案，结果是**先被 A 裁一遍、再被 B 裁一遍**，两次 marker 语义还不同，模型会
// 把「被裁过的」当成「原文就这么点」。
//
// 现在只有这一个数：**64KB / 2000 行 / 单行 2000 字符**。谁要裁剪都来这里取，
// 不要再在别处写字面量（新增一处 = 这个文件白建了）。
//
// 64KB 的来处：dsh 的 bash `maxOutputBytes` 默认 64_000（`~/git-ref/deepseek-harness/
// packages/shell/bash-local/src/index.ts`），用户 2026-11-27 拍板「所有工具都 64k」。
// ⚠️ dsh 那个 8K **不是**这一层：它是 `compaction-tool-result-pruner` 的 thresholdChars，
// 只在**压缩触发时**剪历史里的旧工具结果（头 4096 / 尾 1024），两件事别混。

/** 单次进模型的字节上限（UTF-8）。所有工具共用；超了头尾保留 + marker + 原文可回取。 */
export const TOOL_OUTPUT_MAX_BYTES = 64 * 1024;

/** 单次进模型的行数上限（与字节上限同时生效，谁先到算谁）。read 的行窗口也用它。 */
export const TOOL_OUTPUT_MAX_LINES = 2000;

/**
 * 单行字符上限。
 *
 * 只对**投递层**（一条工具输出里夹着超长行，比如 minified 产物 / 一整个 JSON）生效；
 * read 的窗口**不设**单行上限 —— 那里砍半行等于砍掉一条记录，且 offset 按行计，取不回来
 * （见 `file-read.ts` 头注）。
 */
export const TOOL_OUTPUT_MAX_LINE_CHARS = 2000;

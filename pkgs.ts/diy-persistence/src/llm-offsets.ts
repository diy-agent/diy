// src/llm-offsets.ts
// 🎯 `llm.jsonl` 的**行号 → 字节偏移**索引（##442）。
//
// ── 为什么需要 ──
// llm.jsonl 一行 = 一条消息，但**单行可能有几 MB**（266 实测最长 9.98 MB）。而 `sed -n 'Np'` 必须
// 从文件头扫到第 N 行：50 MB 文件 ~70 ms，175 MB 的 ops ~1 s，且单行整段吐出来会直接撑爆上下文。
// 有了这份索引，取任意一行是 O(1) 且**可以先截断**：
//
//   line=$(sed -n "${N}p" <session>/llmOffsets.jsonl)      # 索引文件只有 100~200 KB
//   tail -c +$((line + 1)) <session>/llm.jsonl | head -c 4000
//
// 这条通道是压缩后「按需回查历史」（`summary.mode: self`）成立的前提：没有它，模型每次回查都要
// 全扫一遍 50 MB，那"让它自己去查"就变成"让它自己去烧钱"。
//
// ── 形状 ──
// `llmOffsets.jsonl`：第 N 行 = llm.jsonl **第 N 行**（1-based）的起始字节偏移（0-based）。
// 一行一个十进制数，append-only（每次压缩重建，见 `writeLlmOffsets`），随会话一起清（`SESSION_KINDS`）。

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { sessionFile, resolveSessionFile } from "./paths";

/**
 * 扫一遍 llm.jsonl，重建偏移索引（**全量重建**，不做增量）。
 *
 * 为什么不做增量：增量要在索引里再存"最后一条的行尾"，而 llm.jsonl 是 append-only 的多写者文件，
 * 行尾对不上就是**静默错位**（读出来的偏移指到别的行中间）。全量重建是幂等的：50 MB 扫描 70 ms，
 * 而它只在**压缩事件**时跑一次（266 一天 65 次 ⇒ 累计 4.5 s），不值得为省这点引入错位风险。
 *
 * @returns 写入的行数（= llm.jsonl 的完整行数；末尾无换行的残行不计）
 */
export function writeLlmOffsets(home: string, taskUri: string): number {
    const src = resolveSessionFile(home, taskUri, "llm");
    const dst = sessionFile(home, taskUri, "llmOffsets");
    if (!existsSync(src)) {
        // 没有 llm.jsonl（还没真发过）⇒ 索引也不该存在；空文件比"残留旧索引"更诚实
        writeAtomic(dst, "");
        return 0;
    }
    const buf = readFileSync(src); // sync-io-ok: 压缩事件时一次（几 MB~几十 MB），非每步路径
    const out: number[] = [0];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a && i + 1 < buf.length) out.push(i + 1);
    }
    writeAtomic(dst, out.map((n) => String(n)).join("\n") + "\n");
    return out.length;
}

/** 读偏移索引（行号 1-based ⇒ `offsets[n - 1]`）；文件不存在 ⇒ 空数组（调用方回落按行扫） */
export function readLlmOffsets(home: string, taskUri: string): number[] {
    const fp = resolveSessionFile(home, taskUri, "llmOffsets");
    if (!existsSync(fp)) return [];
    const text = readFileSync(fp, "utf-8"); // sync-io-ok: 100~200 KB 的旁路索引
    const out: number[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const n = Number(t);
        if (Number.isFinite(n) && n >= 0) out.push(n);
    }
    return out;
}

/** 取第 `line`（1-based）条消息的起始字节偏移；越界 / 无索引 ⇒ null（调用方回落 `sed -n`） */
export function llmOffsetOf(home: string, taskUri: string, line: number): number | null {
    const offsets = readLlmOffsets(home, taskUri);
    if (line < 1 || line > offsets.length) return null;
    return offsets[line - 1]!;
}

/**
 * 文件里**最长一行**的字节数（从偏移索引算，不用再扫全文）：
 * 相邻偏移之差 = 该行长度（含换行）；最后一行 = 文件大小 − 末条偏移。
 *
 * 为什么要这个数：压缩头部消息要告诉模型"单行可能几 MB，取行必须先 `head -c` 截断"
 * （266 实测最长一行 9.98 MB —— 不截断一次就灌满窗口）。取不到（无索引 / 无文件）⇒ null。
 */
export function maxLineBytesOf(home: string, taskUri: string): number | null {
    const offsets = readLlmOffsets(home, taskUri);
    if (offsets.length === 0) return null;
    const src = resolveSessionFile(home, taskUri, "llm");
    if (!existsSync(src)) return null;
    let size: number;
    try {
        size = statSync(src).size; // sync-io-ok: 只取 size，不读内容
    } catch {
        return null;
    }
    let max = 0;
    for (let i = 1; i < offsets.length; i++) max = Math.max(max, offsets[i]! - offsets[i - 1]!);
    return Math.max(max, size - offsets[offsets.length - 1]!);
}

/** 原子写（tmp + rename）：索引是派生物，写坏了顶多下次重建，但**不许**读到半份 */
function writeAtomic(fp: string, text: string): void {
    const tmp = `${fp}.tmp`;
    writeFileSync(tmp, text, "utf-8");
    renameSync(tmp, fp);
}

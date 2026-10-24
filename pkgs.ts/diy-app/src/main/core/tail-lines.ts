// src/main/core/tail-lines.ts —— 从文件**尾部**倒读若干行（不整份读进内存）
//
// 为什么存在（##427）：`events.jsonl` / `deliveries.jsonl` 是 append-only 的事件流，
// 读侧永远只要「最后 N 条」。旧写法 `readFile → split("\n") → slice(-N)` 的**读取与解析成本
// 与 limit 无关** —— 文件涨到 5 MB 就是每次轮询 5 MB 的读 + 全量 JSON.parse。
//
// 判据（谁该用）：
//   · `limit > 0` 且只关心尾部 ⇒ 用这里；
//   · 需要**全量**（按 id 反查历史事件、幂等判据扫全部）⇒ 老老实实 `readFile`，别拿尾部冒充全量。
//
// 三条边界：
//   ① 只认 `\n`（本仓的 jsonl 恒以 `\n` 收尾，由写侧保证）；
//   ② 从尾部往前收块，收到**至少 `maxLines` 行**就停 —— 落在块边界的那半行**丢掉**（它可能
//      连 UTF-8 都被切断），所以在**没到文件头**时返回的第一行是「下一个完整行」；
//   ③ 文件不存在 ⇒ 空结果（`atStart: true`），不抛 —— 与各调用方「没建过」的判断对齐。

import { open } from "node:fs/promises";

const DEFAULT_CHUNK_BYTES = 64 * 1024;

export interface TailLines {
    /**
     * 尾部若干行（按原顺序，`\n` 已剥；不含空尾行）。
     *
     * ⚠️ 可能**多于** `maxLines`：块的粒度是字节，读到文件头时拿到的就是整个文件 ——
     * 想要「恰好 N 行」由调用方自己 `slice(-N)`（这里的契约是「至少读到够」）。
     */
    lines: string[];
    /** 是否读到了文件头（true = 第一行是完整的；false = 第一行是「块边界上被丢掉」之后的那一行） */
    atStart: boolean;
    /** 实际从盘上读了多少字节（可测证据：证明「没有整份读」） */
    bytesRead: number;
}

/**
 * 倒读尾部行。
 *
 * @param file 目标文件
 * @param maxLines 最多要多少行（≤0 ⇒ 空结果）
 * @param chunkBytes 每块字节数（缺省 64 KB；单行超过它就自动多读几块）
 */
export async function readTailLines(file: string, maxLines: number, chunkBytes = DEFAULT_CHUNK_BYTES): Promise<TailLines> {
    if (maxLines <= 0) return { lines: [], atStart: false, bytesRead: 0 };
    let fh;
    try {
        fh = await open(file, "r");
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { lines: [], atStart: true, bytesRead: 0 };
        throw e;
    }
    try {
        const { size } = await fh.stat();
        if (size === 0) return { lines: [], atStart: true, bytesRead: 0 };
        const chunks: Buffer[] = []; // 倒序收集（unshift），最后一次性拼接
        let pos = size;
        let newlines = 0;
        const buf = Buffer.allocUnsafe(chunkBytes);
        let totalRead = 0;
        // 多要一个换行：`maxLines` 行需要 `maxLines` 个「行尾」，尾行可能没有换行符
        while (pos > 0 && newlines <= maxLines) {
            const len = Math.min(chunkBytes, pos);
            pos -= len;
            const { bytesRead } = await fh.read(buf, 0, len, pos);
            totalRead += bytesRead;
            const b = Buffer.from(buf.subarray(0, bytesRead));
            for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) newlines++;
            chunks.unshift(b);
        }
        const atStart = pos === 0;
        const text = Buffer.concat(chunks).toString("utf8");
        let lines = text.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // 文件以 \n 收尾 ⇒ 末段是空串
        // 没到文件头 ⇒ 第一段是被块边界切断的半行（可能是半个字符）—— 丢掉
        if (!atStart && lines.length > 0) lines.shift();
        return { lines, atStart, bytesRead: totalRead };
    } finally {
        await fh.close();
    }
}

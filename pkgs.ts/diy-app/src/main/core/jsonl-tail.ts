// src/main/core/jsonl-tail.ts
// 🎯 jsonl **尾部限读**（##431）：审计型日志的读侧一律不许整份读 + parse。
//
// 病根（实测 266 会话）：`compact.jsonl` 长到 274 MB / 458 行 —— 每次打开「上下文/压缩」页面
// 都 `readFileSync` + 逐行 `JSON.parse`，主线程秒级卡死。而页面上真正要看的是**最近几次压缩**，
// 更早的记录只是审计留档（可清理，见 ##410）。
//
// 契约（调用方可依赖的就这三条）：
//   · **限读**：只读文件尾 `maxBytes`，再只留最后 `maxLines` 个非空行；成本与文件总长无关。
//   · **显式截断**：`truncated: true` 表示「更早的内容没读」。调用方**必须**把它透出来
//     （界面标一行「更早的记录未加载」）—— 静默截断与 ##416「不隐藏信息」相悖。
//   · **半行安全**：从文件中间起读时首行可能是半条（切在多字节字符中间也不怕，JSON.parse
//     失败即跳过）；末行没有换行符照常算一行。
//
// 为什么同步：本函数只服务既有同步读口（local-agent 的投递 fold 链、迁移命令），
// 改异步会把整条链染成 async（同 `readOpsRange` 的取舍，见那里的 sync-io-ok 注记）。
// 代价恒定为几 MB 以内的顺序读，与「整份 274 MB」不是一个量级。

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** 单次限读的缺省上限：256 KB / 200 行 —— 实测足以覆盖最近几十次压缩，单次 < 10 ms。 */
export const JSONL_TAIL_DEFAULT_BYTES = 256 * 1024;
export const JSONL_TAIL_DEFAULT_LINES = 200;

export interface JsonlTail {
    /** 保留的行（已 trim、已去空行；顺序 = 文件顺序） */
    lines: string[];
    /** 实际开始读的字节偏移（0 = 从头读的，即没截断） */
    from: number;
    /** 文件当前字节数（不存在 = 0） */
    size: number;
    /** 有更早的内容没读（`from > 0` 或行数超限） */
    truncated: boolean;
}

/**
 * 读 jsonl 文件的最后 `maxLines` 个非空行（最多读尾部 `maxBytes` 字节）。
 *
 * @param file 目标文件（不存在 → 空结果、`truncated: false`；"没有"与"被截断"是两回事）
 */
export function readJsonlTail(
    file: string,
    opts: { maxBytes?: number; maxLines?: number } = {},
): JsonlTail {
    const maxBytes = Math.max(1, opts.maxBytes ?? JSONL_TAIL_DEFAULT_BYTES);
    const maxLines = Math.max(1, opts.maxLines ?? JSONL_TAIL_DEFAULT_LINES);
    // sync-io-ok: 尾部限读是同步读口（调用方全在同步 fold 窗口）；这里只是一次存在性判定
    if (!existsSync(file)) return { lines: [], from: 0, size: 0, truncated: false };
    let size = 0;
    try {
        size = statSync(file).size; // sync-io-ok: 审计日志尾部限读（O(maxBytes)，与 readOpsRange 同一同步窗口）
    } catch {
        return { lines: [], from: 0, size: 0, truncated: false };
    }
    if (size <= 0) return { lines: [], from: 0, size: 0, truncated: false };
    const start = Math.max(0, size - maxBytes);
    // 多读 1 字节：用它判「起点是不是正好落在行首」（前一字是换行）。
    // 不这么做就只能无条件丢首行 —— 那会把**恰好一条完整行**也丢掉（末行无换行的文件尤其明显）。
    const from = start > 0 ? start - 1 : 0;
    let text = "";
    try {
        const fd = openSync(file, "r"); // sync-io-ok: 审计日志尾部限读（O(maxBytes)，与 readOpsRange 同一同步窗口）
        try {
            const buf = Buffer.allocUnsafe(size - from);
            let got = 0;
            while (got < buf.length) {
                const n = readSync(fd, buf, got, buf.length - got, from + got); // sync-io-ok: 同上一行（定长尾部读）
                if (n <= 0) break;
                got += n;
            }
            text = buf.subarray(0, got).toString("utf-8");
        } finally {
            closeSync(fd); // sync-io-ok: 同上一行（定长尾部读）
        }
    } catch {
        return { lines: [], from, size, truncated: from > 0 };
    }

    let body = text;
    if (from > 0) {
        // 非文件头 ⇒ 首行可能是半行（从中间切的）。丢到第一个换行为止：宁可少读一条，也不喂半条给 JSON.parse。
        const nl = body.indexOf("\n");
        if (nl < 0) return { lines: [], from, size, truncated: true }; // 整段都是半行（窗口比一行还短）
        body = body.slice(nl + 1);
    }
    const raw = body.split("\n");
    const rows: string[] = [];
    for (const r of raw) {
        const t = r.trim();
        if (t) rows.push(t);
    }
    // 行数超限 ⇒ 只留尾部（"最近的记录"才是页面要的）
    const kept = rows.length > maxLines ? rows.slice(rows.length - maxLines) : rows;
    return { lines: kept, from, size, truncated: from > 0 || kept.length < rows.length };
}

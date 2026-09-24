// src/main/core/file-read.ts
// 🎯 文件窗口读取的**唯一实现**：行窗口 + 行/字节双限 + 续读提示。
//
// 为什么单独抽：read 能力有两处消费方 —— 本地 agent 的 read 工具（模型工具调用）
// 与 `diy tool read` CLI 命令（agent 经 bash 调用 / 人工查看）。两处若各写一份，
// 「截断语义」这个最需要一致的东西就会漂移。
// 旧实现是 clip(s, 6000)：取头 3000 + 尾 3000、**中间丢弃**，且没有续读入口
// —— 模型读到大文件的中段内容时，那部分永久拿不回来（实测 App.tsx 440 行丢中段）。
//
// 对齐 dsh / pi / opencode 三家共有的设计：
//   - 行窗口（offset/limit）而非整文件：可以精确跳到没读过的部分
//   - 行数 / 字节双限，谁先到算谁（同一份预算，不叠乘）
//   - 尾部续读提示，把「下一步取哪一段」直接写进输出
//   - 扫完整个文件数行数：续读提示里的「共 N 行」必须是真值，否则会以为读到头了
//
// ⚠️ **不设单行字符数限制**（与 opencode/dsh 的 2000 字符不同，对齐 pi）：
// 单行上限的代价是**信息丢失且不可续读** —— offset 按行计，被砍掉的半行没有任何入口取回。
// jsonl 日志、minified 产物这类「一行就是一条完整记录」的文件里，砍半行等于砍掉整条记录。
// 所以单行只受**字节预算**约束（和所有行同一条预算），不另设小上限。
// 读入时的单行缓冲上限 = 字节预算，那纯粹是内存保护（防一行几个 GB 撑爆进程），
// 不是面向读者的截断：超过它的部分本来也装不进输出。

import { createReadStream } from "node:fs";

/** 单次读取的默认行数上限（对齐三家的 2000） */
export const READ_MAX_LINES = 2000;
/** 输出字节上限（对齐三家的 50KB） */
export const READ_MAX_BYTES = 50 * 1024;
/** 二进制探测的采样字节数（对齐 opencode 的 4KB 采样） */
const BINARY_PROBE_BYTES = 4096;

export interface ReadWindowOptions {
  /** 1-based 起始行（缺省 1） */
  offset?: number;
  /** 最大返回行数（缺省 READ_MAX_LINES） */
  limit?: number;
  /** 输出字节上限（缺省 READ_MAX_BYTES） */
  maxBytes?: number;
}

export interface ReadLine {
  /** 1-based 行号（文件真实行号，不是窗口内序号） */
  number: number;
  text: string;
  /** 该行因内存保护被截到字节预算长度（内容本身超过一整份预算） */
  overflow?: boolean;
}

export interface ReadWindow {
  /** 展示用路径（调用方决定绝对还是相对） */
  path: string;
  /** 实际起始行 */
  offset: number;
  lines: ReadLine[];
  /** 文件总行数（真值：整个文件扫过一遍） */
  totalLines: number;
  /** 是否因字节上限提前收尾（行数还没到 limit） */
  truncatedByBytes: boolean;
}

/** 读取失败；调用方转成面向用户/模型的文案 */
export class ReadWindowError extends Error {
  constructor(
    message: string,
    /** 机器可读的原因，便于调用方分支 */
    readonly reason: "offset-out-of-range" | "binary",
  ) {
    super(message);
    this.name = "ReadWindowError";
  }
}

/** 行尾 \r（CRLF 的 \r 在手动切分时不会被吃掉，末尾无换行时也会残留） */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 读文件的第 offset..offset+limit-1 行，施加行/字节双限。
 *
 * 行数或字节超限后**仍继续扫描**：只数行、不再做字符串拼接，
 * 目的是让 totalLines 是真值（续读提示要写「共 N 行」，报小了会让读者误判读到头）。
 *
 * @param absPath 绝对路径（调用方负责解析相对路径）
 * @param displayPath 展示用路径（原样回显，不参与 IO）
 * @throws ReadWindowError offset 越界 / 二进制内容
 */
export async function readFileWindow(
  absPath: string,
  displayPath: string,
  opts: ReadWindowOptions = {},
): Promise<ReadWindow> {
  const offset = opts.offset ?? 1;
  const limit = opts.limit ?? READ_MAX_LINES;
  const maxBytes = opts.maxBytes ?? READ_MAX_BYTES;

  const lines: ReadLine[] = [];
  let totalLines = 0;
  let bytes = 0;
  let truncatedByBytes = false;
  let binary = false;

  // 单行缓冲上限 = 字节预算：超过它这一行无论如何都装不进输出，继续累积只是白占内存。
  // 按**字符数**近似（中文 1 字符 3 字节，会略超预算）—— 只是内存保护，不影响正确性：
  // 真正的字节预算检查在收行时做（见 below）。
  const lineCap = maxBytes;

  const stream = createReadStream(absPath, { encoding: "utf-8", highWaterMark: 64 * 1024 });
  let pending = "";
  let pendingOverflow = false;
  let probedBytes = 0;

  /** 收一行：计数 + （在窗口内且还有预算时）入列 */
  const flush = (): void => {
    totalLines += 1;
    if (truncatedByBytes) return;
    if (totalLines < offset) return;
    if (lines.length >= limit) return;
    const text = stripCr(pending);
    const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0); // +1 = 换行
    if (bytes + size > maxBytes) {
      truncatedByBytes = true;
      return;
    }
    bytes += size;
    lines.push(pendingOverflow ? { number: totalLines, text, overflow: true } : { number: totalLines, text });
  };

  try {
    for await (const chunk of stream) {
      // 二进制探测：只采样文件开头若干字节（文本文件不含 NUL）
      if (probedBytes < BINARY_PROBE_BYTES) {
        if (chunk.slice(0, BINARY_PROBE_BYTES - probedBytes).includes("\0")) {
          binary = true;
          break;
        }
        probedBytes += chunk.length;
      }
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf("\n", start);
        const seg = nl === -1 ? chunk.slice(start) : chunk.slice(start, nl);
        if (!pendingOverflow) {
          const room = lineCap - pending.length;
          if (seg.length <= room) pending += seg;
          else {
            pending += seg.slice(0, room);
            pendingOverflow = true;
          }
        }
        if (nl === -1) break;
        flush();
        pending = "";
        pendingOverflow = false;
        start = nl + 1;
      }
    }
    // 末尾无换行符的最后一行
    if (!binary && (pending.length > 0 || pendingOverflow)) flush();
  } finally {
    stream.destroy();
  }

  if (binary) throw new ReadWindowError(`${displayPath} 是二进制文件（只读文本）`, "binary");
  // 空文件读 offset=1 不算越界（三家一致的特例）
  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    throw new ReadWindowError(
      `offset ${offset} 超出文件范围（${displayPath} 共 ${totalLines} 行）`,
      "offset-out-of-range",
    );
  }

  return { path: displayPath, offset, lines, totalLines, truncatedByBytes };
}

export interface FormatOptions {
  /** 输出字节上限（用于提示里的数字，缺省 READ_MAX_BYTES） */
  maxBytes?: number;
  /**
   * 续读提示的写法。两种消费方的「下一段怎么取」语法不同，提示必须跟着变，
   * 否则模型会照抄 `--offset` 去调工具参数（工具参数是 `offset`，没有 `--`）：
   *   cli  — `--offset N`（可直接敲的 shell 选项，对齐 `diy tool read`）
   *   tool — `offset=N`（模型工具参数，对齐 opencode/pi/dsh 的提示写法）
   */
  style?: "cli" | "tool";
}

/**
 * 把窗口渲染成模型/人可读的文本。
 *
 * 尾部提示是这块设计的重点：它把「下一步取哪一段」写进输出 ——
 * 读者不必自己推算 offset（推错就会重复读或跳读）。
 */
export function formatReadOutput(w: ReadWindow, opts: FormatOptions = {}): string {
  const maxBytes = opts.maxBytes ?? READ_MAX_BYTES;
  const kb = Math.round(maxBytes / 1024);

  if (w.totalLines === 0) return `${w.path}\n[文件为空]`;

  const out: string[] = [w.path];
  for (const l of w.lines) out.push(`${l.number}: ${l.text}`);

  if (w.lines.length === 0) {
    // 起始行本身就超字节预算（只有中文等宽字符行会走到：字符数≈预算、字节数是它数倍）
    out.push(`[第 ${w.offset} 行超过 ${kb}KB 输出上限，无法整行显示。取该行片段：sed -n '${w.offset}p' <file> | head -c ${maxBytes}]`);
    return out.join("\n");
  }

  const lastLine = w.lines.at(-1)!.number;
  const next = lastLine + 1;
  const cont = opts.style === "tool" ? `offset=${next}` : `--offset ${next}`;
  if (w.truncatedByBytes) {
    out.push(`[已显示 ${w.offset}-${lastLine} 行，共 ${w.totalLines} 行（已达 ${kb}KB 输出上限）。续读：${cont}]`);
  } else if (lastLine < w.totalLines) {
    out.push(`[已显示 ${w.offset}-${lastLine} 行，共 ${w.totalLines} 行。续读：${cont}]`);
  } else {
    out.push(`[文件结束，共 ${w.totalLines} 行]`);
  }
  const overflow = w.lines.filter((l) => l.overflow).length;
  if (overflow > 0) out.push(`[注：有 ${overflow} 行超过 ${kb}KB，仅显示前 ${kb}KB]`);
  return out.join("\n");
}

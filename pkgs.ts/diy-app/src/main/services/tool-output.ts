// src/main/services/tool-output.ts
// 🎯 **单条工具输出**的投递层截断（##127）—— 头尾保留 + 明确 marker + 原文落盘可 `read` 回取
//
// ── 落点为什么必须是 `toModelOutput`（AI SDK 的「工具结果 → 模型消息」钩子），而不是 `execute` ──
//   · `execute` 的返回值 = 落进 ops 的**原文**（UI / 日志 / 后续压缩都从它取）。在 execute 里裁 =
//     原文当场丢（用户也看不到全量），且与新输出的 UI 显示不一致；
//   · `toModelOutput` 只改写**发给模型的那一份**，且**在投递时现算** —— marker 与原文落盘都在这里，
//     ops 原文永不动（##343 的硬边界）。
//
// ── 三条路径同一条预算（不再有「报错被裁、成功裸奔」的不对称）──
//   · bash 成功 / bash 报错 —— 本文件的 `capToolOutput`：头尾各半 + marker + 原文落 `local/toolout/`；
//   · read —— `core/file-read.ts` 的行窗口（`offset` 续读），**共用同一对常量**
//     （`READ_MAX_LINES` / `READ_MAX_BYTES`）⇒ 三处的「一条输出能有多大」是同一个数。
//   旧行为：报错走 `clip(s, 6000)`、成功**裸 return**，唯一兜底是 `execFile` 的 `maxBuffer` 静默截断
//   （ENOBUFS，模型与用户都拿不到信号）—— 风险正好反了：真正撑爆上下文的是成功的大输出。

import { mkdirSync } from "node:fs";
import { writeFileAtomic } from "../core/atomic-write";
import path from "node:path";
import { clipToolResult, type ToolResultPolicy } from "../../shared/context/compaction";
import { localDir } from "../core/local-paths";
import { READ_MAX_BYTES, READ_MAX_LINES } from "../core/file-read";

/** 单条工具输出的预算（**与 read 的窗口同一对常量**：三路径一个策略） */
export const TOOL_OUTPUT_MAX_LINES = READ_MAX_LINES;
export const TOOL_OUTPUT_MAX_BYTES = READ_MAX_BYTES;

/** 头尾保留行数（##127「头尾各半」；触发阈值 = head + tail = 单条预算的行数） */
export const TOOL_OUTPUT_HEAD_LINES = TOOL_OUTPUT_MAX_LINES / 2;
export const TOOL_OUTPUT_TAIL_LINES = TOOL_OUTPUT_MAX_LINES / 2;

/**
 * 工具输出层的裁剪策略（唯一真源）。与**历史投递层**同用 `clipToolResult` ⇒ marker 文案同构
 * （`[... 中间省略 N 行 / X KB，完整输出见 <path> ...]`），只有参数不同（这里是「一条输出」的预算，
 * 那里是用户拧的 `toolResult.render`）。
 */
export const TOOL_OUTPUT_POLICY: ToolResultPolicy = {
    render: "headtail",
    renderData: {
        head: TOOL_OUTPUT_HEAD_LINES,
        tail: TOOL_OUTPUT_TAIL_LINES,
        maxLineChars: 2000,
        maxKeepBytes: TOOL_OUTPUT_MAX_BYTES,
    },
};

/** 工具 id 里的非法文件名字符归一（块 id 形如 `call_abc` / `t1759_s1_r1`，一般无需动） */
export function safeId(id: string): string {
    return id.replace(/[^\w.-]+/g, "_");
}

/** 被裁剪工具输出的原文落盘目录（模型可回取；##127 的「原文可寻回」） */
export function toolOutDir(): string {
    const d = path.join(localDir(), "toolout");
    mkdirSync(d, { recursive: true });
    return d;
}

/**
 * 落盘位置（**绝对路径**）。为什么不给相对路径：模型（与 read 工具）只按 **cwd** 解析相对路径，
 * `local/toolout/…` 它根本读不到 —— marker 里给一个读不到的路，等于没给。
 * 账本里的 `origPath` 仍是相对路径（见 `toolOutRelPath`：那里要的是**可移植**，给人看）。
 */
export function toolOutFile(id: string): string {
    return path.join(toolOutDir(), `${safeId(id)}.txt`);
}

/** 相对 `$DIY_HOME` 的写法（**账本 / 投递 marker** 用：可移植，不随机器变） */
export function toolOutRelPath(id: string): string {
    return `local/toolout/${safeId(id)}.txt`;
}

export interface CappedToolOutput {
    /** 发给模型的文本（未超限时与原文**逐字符相同**） */
    text: string;
    /** 是否发生了截断（只有截断才落盘，避免给每条小输出写文件） */
    clipped: boolean;
    /** 原文落盘位置（绝对路径；未截断 = 无） */
    origPath?: string;
}

/**
 * 单条工具输出 → **发给模型的那一份**（##127）。
 *
 * 超限（> 2000 行 / > 50KB / 有超长行）时：头尾保留 + marker；原文**落盘**（绝对路径写进 marker，
 * 模型可 `read` 回取被省略的中段）。落盘失败（磁盘满/权限）不假装成功：退化成不带路径的 marker
 * （`完整输出已省略`），模型至少知道「被截了」。
 */
export function capToolOutput(text: string, toolCallId: string): CappedToolOutput {
    const probe = clipToolResult(text, TOOL_OUTPUT_POLICY);
    if (!probe.clipped) return { text, clipped: false };

    const origPath = toolOutFile(toolCallId);
    let hint: string | undefined;
    try {
        writeFileAtomic(origPath, text);
        hint = origPath;
    } catch {
        hint = undefined; // 落盘失败 → 不给路径（不指向一个不存在的文件）
    }
    const r = hint ? clipToolResult(text, TOOL_OUTPUT_POLICY, { origPath: hint }) : probe;
    return hint ? { text: r.text, clipped: true, origPath: hint } : { text: r.text, clipped: true };
}

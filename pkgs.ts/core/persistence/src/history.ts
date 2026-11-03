// src/history.ts
// 🎯 core 的**唯一历史读口**：`loadHistory(home, taskUri)` —— 会话从哪读、读出来后是什么形状。
//
// 为什么收敛成一个函数（##432 刀 1）：core 以前自己拼「压缩账本 → 重放起点 → ops 读取 → 降级链」，
// 于是它知道 ops 文件在哪、行号怎么算、turns 的 ref 指什么 —— 这些**存储知识**一旦泄漏，
// 存储格式就改不动了。现在 core 只说：给我这个任务的历史。
//
// 两条路：
//   · 正常：`{ from, lineBase, kind, note }` —— core 用 `readOpsFrom(home, uri, from)` 拿 op 数组；
//   · 降级（ops 缺失 / 空 / 断代）：`{ ops, degraded }` —— 已由 turns 折好的只读文本历史。

import { existsSync } from "node:fs";
import { countFileLines, fileSize, isTurnStartAt, readOpsFrom, readOpsRange } from "./ops-io.js";
import { llmFile, opsFile, resolveSessionFile } from "./paths.js";
import { checkOpsRef, readBoundary, readTurnRecords, synthesizeTurnOps, type TurnOp } from "./turns.js";

/** 重放起点（core 用它决定从 ops 的哪个字节开始读） */
export interface ReplayInfo {
    /** 从哪个字节开始重放（0 = 全量） */
    from: number;
    /** 该起点对应的 llm.jsonl 行号偏移（= 被跳过的消息条数） */
    lineBase: number;
    /**
     * full          从未压缩 ⇒ 全量
     * offset        按压缩边界的 ops 锚点跳前缀
     * schema-break  边界格式断代 ⇒ 起点 EOF（旧段只作审计）
     * truncated     文件比压缩时还短（被截断 / 换了一份）⇒ 起点作废
     */
    kind: "full" | "offset" | "schema-break" | "truncated";
    /** 断代的**可见标记**（不许静默空白） */
    note?: string;
}

export type DegradedCause = "missing" | "empty" | "schema-break" | "truncated";

export interface DegradedHistory {
    cause: DegradedCause;
    note: string;
    /** 由 turns 重建的轮数 */
    turns: number;
    /** 锚点悬空的轮数 */
    dangling: number;
}

/**
 * 解析重放起点（##420 / ##432）。
 *
 * 判定顺序（任一破了就退到更保守的一档）：
 *   ① 没有压缩边界（从未压过）→ 全量；
 *   ② 边界记的 cut 落在 llm 行号之外 → 全量（不敢按它跳）；
 *   ③ `size < 边界记的 opsBytes` → 文件被截断/替换 → **断代**（**绝不回退 0**）；
 *   ④ 边界没有 ops 锚点（压缩时定位失败）→ 全量。
 */
export function resolveReplay(home: string, taskUri: string): ReplayInfo {
    const full: ReplayInfo = { from: 0, lineBase: 0, kind: "full" };
    const boundary = readBoundary(home, taskUri);
    if (!boundary) return full;
    const fp = opsFile(home, taskUri);
    const size = fileSize(fp);
    const lineBase = Math.max(0, boundary.cut.llmLine - 1);
    const anchor = boundary.ref?.ops;
    if (anchor && Number.isInteger(anchor.offset) && anchor.offset > 0) {
        if (anchor.offset > size) {
            return {
                from: size,
                lineBase: countFileLines(llmFile(home, taskUri)),
                kind: "truncated",
                note: `起点作废：ops 现有 ${size}B < 压缩时记录的 ${anchor.offset}B（被截断/替换）→ 断代，不回退从 0 读`,
            };
        }
        if (!isTurnStartAt(fp, anchor.offset)) {
            // 锚点不是轮首行（手改 / 旧文件）→ 老实全读（宁可慢，不可错位）
            return full;
        }
        return { from: anchor.offset, lineBase, kind: "offset" };
    }
    return full;
}

/** 降级链的判定 + 重建材料（ops 读不出明细时）：`null` = 正常路径（不用 turns）。 */
export function loadDegradedHistory(
    home: string,
    taskUri: string,
    replay: ReplayInfo,
): { ops: TurnOp[]; degraded: DegradedHistory } | null {
    const fp = resolveSessionFile(home, taskUri, "ops");
    // sync-io-ok: 「在不在」与「多大」要分开答（missing / empty 是两种降级原因），冷路径
    const present = existsSync(fp);
    const size = fileSize(fp);
    let cause: DegradedCause | null = null;
    let note = "";
    if (!present) {
        cause = "missing";
        note = "会话 ops 日志不存在（被清理 / 换了数据根 / 从未写出）";
    } else if (size <= 0) {
        cause = "empty";
        note = "会话 ops 日志为空";
    } else if (replay.kind === "schema-break") {
        cause = "schema-break";
        note = replay.note ?? "ops 格式断代";
    } else if (replay.kind === "truncated") {
        cause = "truncated";
        note = replay.note ?? "ops 被截断 / 换了一份";
    }
    if (cause === null) return null;

    const records = readTurnRecords(home, taskUri);
    const surviving: TurnOp[] = present ? readOpsFrom<TurnOp>(fp, replay.from) : [];
    const aliveTurns = new Set<string>();
    for (const op of surviving) if (op.op === "start" && op.kind === "turn") aliveTurns.add(op.id);
    const ops: TurnOp[] = [];
    let turns = 0;
    let dangling = 0;
    for (const rec of records) {
        if (aliveTurns.has(rec.turnId)) continue; // 真实 op 还在 ⇒ 不拿文本记录顶掉它
        const check = checkOpsRef(home, taskUri, rec.ref.ops);
        if (!check.ok) dangling++;
        ops.push(...synthesizeTurnOps(rec, !check.ok));
        turns++;
    }
    // 存活段照旧拼在后面（它们是可用明细）；core 负责折叠成块树
    if (surviving.length > 0) ops.push(...surviving);
    if (ops.length === 0 && present && size > 0) {
        // 文件在、有内容，但降级链重建为空（断代 + 没有 turns.jsonl）：
        // 旧 ops 段对本 UI 仍是**可展示**的历史 —— 交回正常路径整份重放（宁可慢也不能静默空白）
        return null;
    }
    return { ops, degraded: { cause, note, turns, dangling } };
}

/** 读从 `from` 起的 op 行（core 只需这一句，路径/行首校验都在包里）。 */
export function readOps(home: string, taskUri: string, from = 0): TurnOp[] {
    return readOpsFrom<TurnOp>(opsFile(home, taskUri), from);
}

/** 读 `[from, to)` 的 op 行（定长窗口；上滚取段用）。 */
export function readOpsWindow(home: string, taskUri: string, from: number, to: number): TurnOp[] {
    return readOpsRange<TurnOp>(opsFile(home, taskUri), from, to).ops;
}

// src/main/core/context-changelog.ts
// 🎯 变更历史的**文件层**：按任务一份 `$DIY_HOME/local/<key>.changelog.jsonl`。
//
// 为什么按任务（与 context-stats.ts 按项目相反）：变更历史是**一条时间线**，问的是
// 「这一步相对上一步改了什么」；跨任务拼接的时间线没有意义。长期统计走 context-stats.jsonl。
//
// 二版（##310）：**每步**一条、有变才写；首条 = `baseline`（整棵树）。seq 是**文件内**序号
// （0-based），重启从末行 +1 续 —— 它只用于排序/去重，不承担跨文件语义。
//
// 与 context-stats.ts 同一套做法：append-only + 读时出声跳过坏行（观测不能阻断发送）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isV2Entry, type CtxLogEntry } from "../../shared/context/changelog";
import { keyOf, localDir } from "./local-paths";

/** 某任务的变更日志文件 */
export function ctxLogFile(taskUri: string): string {
    return join(localDir(), `${keyOf(taskUri)}.changelog.jsonl`);
}

/** 追加一条（append-only；写失败只出声 —— 观测不能阻断发送）。新旧形状都收（老文件不重写） */
export function appendCtxLog(taskUri: string, rec: CtxLogEntry | Record<string, unknown>): void {
    const fp = ctxLogFile(taskUri);
    try {
        mkdirSync(localDir(), { recursive: true });
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (e) {
        console.error(`[context-changelog] 写入失败 ${fp}:`, e);
    }
}

/** 读某任务的变更日志**原始行**（时间正序；文件不存在 = 还没有数据）。形状判别交给调用方 */
export function readCtxLog(taskUri: string): unknown[] {
    const fp = ctxLogFile(taskUri);
    if (!existsSync(fp)) return [];
    const out: unknown[] = [];
    for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            out.push(JSON.parse(t));
        } catch (e) {
            console.warn(`[context-changelog] 跳过无法解析的行 ${fp}:`, String(e).slice(0, 100));
        }
    }
    return out;
}

/** 只取二版记录（有 `type` 的） */
export function readCtxLogEntries(taskUri: string): CtxLogEntry[] {
    return readCtxLog(taskUri).filter(isV2Entry);
}

/** 文件里最后一条二版记录的 seq；没有 = -1（新文件从 0 开始） */
export function lastCtxLogSeq(taskUri: string): number {
    const entries = readCtxLogEntries(taskUri);
    return entries.length === 0 ? -1 : entries[entries.length - 1]!.seq;
}

/**
 * 是否已有**二版**记录 —— 决定"该不该补一条 baseline（起点）"。
 *
 * 判据是「有二版记录」而不是「文件非空」：老文件里全是老格式（没有 `type`）时读侧一路走降级
 * 路径（UI 只有变化路径、没有值预览），**补一条二版起点**才切得到新格式。曾经用 `readCtxLog().length > 0`，
 * 于是老任务升级后永远补不上起点、UI 永远停在降级视图（##310 review 意见 1 的同一根因）。
 *
 * 反过来，**进程重启不算会话边界**（对话从盘上重建、继续），所以这里不因重启写新起点；
 * 「从此刻重新起算」走显式入口：`diy context rebaseline` 或会话清零
 * （见 local-agent 的 `rebaselinePending`）。
 */
export function hasV2CtxLog(taskUri: string): boolean {
    return readCtxLogEntries(taskUri).length > 0;
}

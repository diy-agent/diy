// src/main/core/context-changelog.ts
// 🎯 变更历史的**文件层**：按任务一份 `$DIY_HOME/local/<key>.changelog.jsonl`。
//
// 为什么按任务（与 context-stats.ts 按项目相反）：变更历史是**一条时间线**，问的是
// 「这轮相对上轮改了什么」；跨任务拼接的时间线没有意义（任务的上一轮 ≠ 项目的上一轮）。
// 长期统计（"这个节点变了几次"）走 context-stats.jsonl（按项目累计）。
//
// 与 steps.jsonl 同一目录、同一 key、同点写（runTurn 里紧挨着 append）—— 于是**轮序天然对齐**：
// 第 N 条 changelog 恒对应第 N 条投递快照。这也是事件行能驱动"第 N 步 vs 上一步"的前提。
//
// 与 context-stats.ts 同一套做法：append-only + 读时出声跳过坏行（观测不能阻断发送）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CtxLogRecord } from "../../shared/context/changelog";
import { keyOf, localDir } from "./local-paths";

/** 某任务的变更日志文件 */
export function ctxLogFile(taskUri: string): string {
    return join(localDir(), `${keyOf(taskUri)}.changelog.jsonl`);
}

/** 追加一条（append-only；写失败只出声 —— 观测不能阻断发送） */
export function appendCtxLog(taskUri: string, rec: CtxLogRecord): void {
    const fp = ctxLogFile(taskUri);
    try {
        mkdirSync(localDir(), { recursive: true });
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (e) {
        console.error(`[context-changelog] 写入失败 ${fp}:`, e);
    }
}

/** 读某任务的变更日志（时间正序；文件不存在 = 还没有数据） */
export function readCtxLog(taskUri: string): CtxLogRecord[] {
    const fp = ctxLogFile(taskUri);
    if (!existsSync(fp)) return [];
    const out: CtxLogRecord[] = [];
    for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const r = JSON.parse(t) as CtxLogRecord;
            out.push({ ...r, ops: r.ops ?? [] });
        } catch (e) {
            console.warn(`[context-changelog] 跳过无法解析的行 ${fp}:`, String(e).slice(0, 100));
        }
    }
    return out;
}

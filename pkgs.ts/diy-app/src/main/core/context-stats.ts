// src/main/core/context-stats.ts
// 🎯 变更统计的**文件层**：按项目一份 $DIY_HOME/projects/<pid>/context-stats.jsonl。
//
// 为什么按项目而不是按任务：要回答"用了 3 天，某个节点变了几次" —— 跨任务累计才有意义
// （同一项目下多个任务共享同一批节点定义，单任务样本太小）。
// 为什么另开文件而不塞进 steps.jsonl：stats 要长期留（只存变化路径，小），
// steps 存全文（大，按任务、可被清理）。两者生命周期不同。
//
// 与 context-config.ts 同一套做法：append-only + 读时出声跳过坏行。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextStatRecord } from "../../shared/context/stats";

/** 项目的统计文件（与 tasks/ 同级） */
export function contextStatsFile(projectDir: string): string {
    return join(projectDir, "context-stats.jsonl");
}

/** 追加一条（append-only；写失败只出声 —— 观测不能阻断发送） */
export function appendContextStat(projectDir: string, rec: ContextStatRecord): void {
    const fp = contextStatsFile(projectDir);
    try {
        mkdirSync(dirname(fp), { recursive: true });
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (e) {
        console.error(`[context-stats] 写入失败 ${fp}:`, e);
    }
}

/** 读某项目的全部统计（时间正序；文件不存在 = 还没有数据） */
export function readContextStats(projectDir: string): ContextStatRecord[] {
    const fp = contextStatsFile(projectDir);
    if (!existsSync(fp)) return [];
    const out: ContextStatRecord[] = [];
    for (const line of readFileSync(fp, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            out.push(JSON.parse(t) as ContextStatRecord);
        } catch (e) {
            console.warn(`[context-stats] 跳过无法解析的行 ${fp}:`, String(e).slice(0, 100));
        }
    }
    return out;
}

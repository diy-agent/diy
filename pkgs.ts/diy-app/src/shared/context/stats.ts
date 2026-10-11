// src/shared/context/stats.ts
// 🎯 上下文节点的**变更统计**（纯函数 + 类型，落盘形状与聚合都在这里）。
//
// 为什么需要它：节点的投递位置（system / runtime）现在只能**猜** —— 没有变更频率数据。
// 跑一段时间后要回答的问题是：「用了 3 天，`os.soft` 到底变了几次 / 共多少轮」——
// 变化多的节点放 system 就是每轮断缓存，该移到 runtime。这份统计就是那个判据。
//
// 与 steps.jsonl 的分工：
//   steps.jsonl  每轮一条**全文**（供 diff 与历史回放）→ 大，按任务
//   stats.jsonl  每轮一条**只有变化路径**（供长期累计）→ 小，**按项目**（跨任务累计）
// 分开的理由：统计要长期留（"用几天后"），全文不能长期留（体积）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import type { DeliveryStepRecord } from "./steps";

/** 一条变更统计（落盘形状；一行一条，append-only） */
export interface ContextStatRecord {
    /** 记录时刻（ISO） */
    ts: string;
    /** 哪个任务（下钻用：同一项目里按任务过滤） */
    taskUri: string;
    /** 轮次 id（与 ops/审计同一套，便于交叉检索） */
    turnId: string;
    /** 与**同一任务的上一轮**相比，值 hash 变化的 path（字典序）；首轮 = `[]`（没有上一轮就没有"变化"，RV-15） */
    changed: string[];
}

/**
 * 两份值 hash 表 → 变化路径（字典序）。
 * 增（新 path）与删（消失的 path）都算变化；值相同不算。
 *
 * `prev` 为 null（**没有上一轮**，如某任务的首轮）→ `[]`：没有可比对的基线，就谈不上"变化"。
 * 曾把这里写成"全部存在的 path 算变化"，于是每个任务首轮把 41 个 path 全记成变化，
 * 从不变过的 `diy`/`guard`/`rules` 被显示成"变了 39 次 · 7.2%"（review RV-15）。
 */
export function changedPaths(
    prev: Record<string, string> | null,
    next: Record<string, string>,
): string[] {
    if (!prev) return [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    return [...keys].filter((k) => prev[k] !== next[k]).sort();
}

/**
 * 首轮基线不算变化 —— **存量数据**侧（review RV-15）。
 *
 * 修写入器只对**新**记录生效（`statFromStep` 现在给 `[]`），而 stats 是长期累计、
 * append-only 的：老文件里那批"首轮 = 全部 path"的记录会一直污染「变了 / 变化率」列。
 * 本函数按同一规则把**每个任务在本文件里的第一条记录**的 `changed` 抹成 `[]`
 * （append-only ⇒ 文件里某任务的第一条就是它的首轮）。新记录本就是 `[]`，此函数对它是恒等变换。
 *
 * ⚠️ 必须在**过滤 / 切片之前**调用：`slice(-limit)` 剩下那批的最早一条不是首轮，事后无从分辨。
 */
export function dropBaselineChanges(records: readonly ContextStatRecord[]): ContextStatRecord[] {
    const seen = new Set<string>();
    return records.map((r) => {
        const first = !seen.has(r.taskUri);
        seen.add(r.taskUri);
        return first && r.changed.length > 0 ? { ...r, changed: [] } : r;
    });
}

/** 单个节点的统计 */
export interface PathStat {
    path: string;
    /** 变化次数（与上一轮不同即计一次） */
    changes: number;
    /** 变化率 = changes / turns（0~1；"多久变一次"） */
    rate: number;
    /** 最后一次变化时刻（ISO） */
    lastChanged: string | null;
    /** 涉及的轮次（用于下钻：点开看是哪几轮） */
    turns: number[];
}

export interface StatsSummary {
    /** 统计口径：总轮数（该范围内所有任务的轮次之和） */
    turns: number;
    /** 时间范围（记录里最早/最晚的 ts） */
    since: string | null;
    until: string | null;
    /** 参与的记录条数（= 真发轮数） */
    records: number;
    /** 参与的任务数（跨任务累计时，让"轮数"的口径一眼可辨） */
    taskCount: number;
    /** 按变化次数**降序**（并列按路径字典序，保证输出稳定） */
    paths: PathStat[];
}

/**
 * 聚合统计。`paths` 只包含**曾经变化过**的节点 —— 不变的不需要提示用户移位置。
 *
 * 为什么按"变化次数"而不是"变化率"排序：两者都给了，但排序用次数 ——
 * 偶尔跑 3 轮却全变（rate=1）的节点，不该排在跑了 200 轮变了 50 次（rate=0.25）的前面。
 * 次数更能反映"这个节点是不是在持续打扰缓存"。
 */
export function summarizeStats(records: readonly ContextStatRecord[]): StatsSummary {
    const turns = records.length;
    const acc = new Map<string, PathStat>();
    records.forEach((r, i) => {
        for (const p of r.changed) {
            let s = acc.get(p);
            if (!s) {
                s = { path: p, changes: 0, rate: 0, lastChanged: null, turns: [] };
                acc.set(p, s);
            }
            s.changes += 1;
            s.lastChanged = r.ts;
            s.turns.push(i + 1);
        }
    });
    const paths = [...acc.values()]
        .map((s) => ({ ...s, rate: turns > 0 ? s.changes / turns : 0 }))
        .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path));
    const ts = records.map((r) => r.ts).sort();
    return {
        turns,
        records: turns,
        taskCount: new Set(records.map((r) => r.taskUri)).size,
        since: ts[0] ?? null,
        until: ts[ts.length - 1] ?? null,
        paths,
    };
}

/**
 * 从投递快照造一条统计记录（真发路径用）。
 * `prevHashes` = **同一任务上一轮**的值 hash 表；首轮传 null（→ 不算变化，见 `changedPaths`）。
 */
export function statFromStep(
    step: DeliveryStepRecord,
    prevHashes: Record<string, string> | null,
    taskUri: string,
): ContextStatRecord {
    return {
        ts: step.ts,
        taskUri,
        turnId: step.turnId,
        changed: changedPaths(prevHashes, step.valueHashes),
    };
}

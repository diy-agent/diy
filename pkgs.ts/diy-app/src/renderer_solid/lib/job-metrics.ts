/**
 * job-metrics.ts — 指标页的**全部判定**（纯函数、零 IO、零 Solid）。
 *
 * 为什么单独立一份：`JobMetricsView.tsx` 只该做渲染。哪些点算「本任务的」、
 * 直方图怎么合并、桶怎么起名、按任务摊平后怎么排序 —— 这些都会**错给用户看错数**，
 * 按本仓惯例（`chat-scroll.ts` / `run-view.ts` 同规格）放进纯函数并逐条钉单测。
 *
 * 一条硬约束：**这里不算派生指标**（平均值只做呈现用，不回写成新指标、不另立口径）。
 */

import { DURATION_BUCKETS_MS } from "../../shared/metric-names";
import type { HistogramValue, MetricPointView, MetricView } from "../../shared/metric-names";

/** 没有 origin 的 run 落到这个维度（与 `shared/metrics.ts` 的 `NO_TASK` 同一个约定）。 */
export const NO_TASK = "_none";

/** 点里的标量（直方图取样本数 —— 面板上「几条」永远指 count） */
export function num(v: MetricPointView["value"]): number {
    return typeof v === "number" ? v : v.count;
}

/** 毫秒 → 人话。只用于展示（桶标签 / 平均时长），不参与计算。 */
export function msText(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * 视角过滤：`all` 拿全量点，「本任务」只留 `task_uri` 相符的。
 *
 * 只过滤、不补零 —— 没跑过的任务本来就没有点，凭空空造一行只会让人以为它跑过。
 */
export function pointsOf(m: MetricView | null, uri: string, all: boolean): MetricPointView[] {
    if (!m) return [];
    if (all) return m.points;
    return m.points.filter((p) => p.attrs.task_uri === uri);
}

/** 按某维度聚合，降序（并列保持稳定顺序 —— 面板上条形图不该自己跳来跳去）。 */
export function groupBy(points: MetricPointView[], key: string): Array<{ k: string; v: number }> {
    const acc = new Map<string, number>();
    for (const p of points) {
        const k = String(p.attrs[key] ?? "—");
        acc.set(k, (acc.get(k) ?? 0) + num(p.value));
    }
    return [...acc.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k));
}

/**
 * 把按任务拆开的直方图合成一份（面板只画一张分布）。
 *
 * `boundaries` 一律取**当前定义**的桶（`DURATION_BUCKETS_MS`），不采信点自带的边界：
 * 老的快照可能用旧桶，混着拼接会把不同边界的 counts 加到同一格里。
 * 空（count 为 0 或没有带时长的点）⇒ `null`，让 UI 显示空态而不是一条零高度的图。
 */
export function histMerged(points: MetricPointView[]): HistogramValue | null {
    const hs = points.filter((p) => typeof p.value !== "number").map((p) => p.value as HistogramValue);
    if (hs.length === 0) return null;
    const out: HistogramValue = {
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
        boundaries: [...DURATION_BUCKETS_MS],
        counts: DURATION_BUCKETS_MS.map(() => 0),
    };
    for (const h of hs) {
        out.count += h.count;
        out.sum += h.sum;
        out.min = Math.min(out.min, h.min);
        out.max = Math.max(out.max, h.max);
        for (let i = 0; i < out.counts.length; i += 1) out.counts[i] += h.counts[i] ?? 0;
    }
    if (out.count === 0) return null;
    return out;
}

/** 桶标签：`(下界, 上界]`；最后一档是 `> 上界`（含全部超长活）。 */
export function bucketLabel(i: number, bounds: readonly number[] = DURATION_BUCKETS_MS): string {
    if (i >= bounds.length) return `> ${msText(bounds[bounds.length - 1] ?? 0)}`;
    const lo = i === 0 ? 0 : bounds[i - 1];
    return `${lo === 0 ? "0" : msText(lo)}–${msText(bounds[i] ?? 0)}`;
}

export interface TaskRow {
    task: string;
    running: number;
    started: number;
    settled: number;
}

/**
 * 按任务摊平（三张卡的总数对不上时，这张表是分诊台）。
 *
 * 排序：先看在跑（谁真占着资源），再看启动次数（谁历史上跑得多），
 * 最后按名字定序 —— 否则两个 0 的行每次刷新都会换位置。
 */
export function taskRows(input: {
    running: MetricPointView[];
    started: MetricPointView[];
    settled: MetricPointView[];
}): TaskRow[] {
    const acc = new Map<string, TaskRow>();
    const touch = (t: string): TaskRow => {
        const hit = acc.get(t);
        if (hit) return hit;
        const fresh: TaskRow = { task: t, running: 0, started: 0, settled: 0 };
        acc.set(t, fresh);
        return fresh;
    };
    for (const p of input.running) touch(String(p.attrs.task_uri ?? NO_TASK)).running += num(p.value);
    for (const p of input.started) touch(String(p.attrs.task_uri ?? NO_TASK)).started += num(p.value);
    for (const p of input.settled) touch(String(p.attrs.task_uri ?? NO_TASK)).settled += num(p.value);
    return [...acc.values()].sort(
        (a, b) => b.running - a.running || b.started - a.started || a.task.localeCompare(b.task),
    );
}

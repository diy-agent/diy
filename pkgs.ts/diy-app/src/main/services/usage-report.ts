// src/main/services/usage-report.ts
// 🎯 用量账本的**读取与 CLI 渲染**（结构化数据由 shared/usage 聚合，UI 走同一个 RPC）。
//
// 为什么表格文本在 main 而不是 CLI 进程：CLI 只是 RPC 客户端（CliApp 直接打印返回的
// 字符串），渲染逻辑留在这里才能保证「UI 与 CLI 数的是同一份账」—— 数字同源是 ##227
// 的硬要求（对不上后台的那次教训就是两处各算各的）。

import { readStepUsages } from "./local-agent";
import {
    fmtCost,
    fmtInt,
    fmtTokens,
    groupByAgent,
    stepView,
    type StepUsageRecord,
    type UsageBuckets,
} from "../../shared/usage";

/** 读取某任务的逐步用量（时间正序） */
export function readUsage(taskUri: string): StepUsageRecord[] {
    return readStepUsages(taskUri);
}

// ─── 等宽表格（中文按 2 列宽，否则全角行整列错位）──

function dispWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
    return w;
}

function pad(s: string, w: number): string {
    return s + " ".repeat(Math.max(0, w - dispWidth(s)));
}

function table(header: string[], rows: string[][]): string {
    const widths = header.map((h, i) => Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] ?? ""))));
    const line = (cells: string[]): string => cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();
    return [line(header), ...rows.map(line)].join("\n");
}

/** token 列：不可测 → `–`（不写 0） */
const cellOpt = (n: number | null): string => (n == null ? "–" : fmtTokens(n));

/** 耗时（ms → 1.84s / 812ms）；缺数 → `–` */
function cellMs(ms: number | undefined): string {
    if (ms == null) return "–";
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const cellWindow = (b: UsageBuckets, limit: number | undefined): string => {
    const r = b.total / (limit ?? 0);
    return Number.isFinite(r) && limit ? `${(r * 100).toFixed(2)}%` : "–";
};

export interface UsageTableOpts {
    /** 只看最近 N 步 */
    last?: number;
    /** 展开金额细分列（非缓存$/缓存读$/缓存写$/文本$/思考$） */
    cost?: boolean;
}

/** 逐步明细表（`diy agent usage <task>`） */
export function renderUsageSteps(steps: StepUsageRecord[], opts: UsageTableOpts = {}): string {
    const list = opts.last && opts.last > 0 ? steps.slice(-opts.last) : steps;
    if (list.length === 0) return "（还没有用量记录：跑一轮本地 agent 后写入 <key>.usage.jsonl）";
    // 步标识用「轮.步」而不是全局序号：序号与盘上的 turnId 对不上时，
    // 排查「这一步到底属于哪一轮」要来回数——而那正是最常问的问题。
    const turnNo = new Map<string, number>();
    for (const r of steps) if (!turnNo.has(r.turnId)) turnNo.set(r.turnId, turnNo.size + 1);
    const header = ["轮.步", "人物", "模型", "面", "档位", "非缓存输入", "缓存读", "缓存写", "总输出(文本+思考)", "耗时", "TTFT", "窗口%", "合计$"];
    if (opts.cost) header.splice(13, 0, "非缓存$", "缓存读$", "缓存写$", "文本$", "思考$");
    const rows = list.map((r) => {
        const v = stepView(r);
        const b = v.buckets;
        const cells = [
            `${turnNo.get(r.turnId) ?? "?"}.${r.step}`,
            r.persona ?? "—",
            r.model,
            r.apiFace === "responses" ? "resp" : "chat",
            r.reasoningEffort ?? "—",
            fmtInt(b.noCache),
            fmtInt(b.cacheRead),
            cellOpt(b.cacheWrite),
            `${fmtInt(b.outputTotal)}(${fmtInt(b.text)}+${fmtInt(b.reasoning)})`,
            cellMs(r.performance?.stepTimeMs),
            cellMs(r.performance?.timeToFirstOutputMs),
            cellWindow(b, r.contextLimit),
            v.cost ? fmtCost(v.cost.total) : "n/a",
        ];
        if (opts.cost) {
            // 金额细分：思考是总输出的子集（不另加），故「文本$ + 思考$ = 总输出金额」
            cells.push(
                v.cost ? fmtCost(v.cost.noCache) : "n/a",
                v.cost ? fmtCost(v.cost.cacheRead) : "n/a",
                v.cost?.cacheWrite == null ? "n/a" : fmtCost(v.cost.cacheWrite),
                v.cost ? fmtCost(v.cost.text) : "n/a",
                v.cost ? fmtCost(v.cost.reasoning) : "n/a",
            );
        }
        return cells;
    });
    return table(header, rows);
}

/**
 * 会话汇总表：按**人物**分行（`--by-agent`）。
 * 不带模型/面/档位列 —— 同一人物的各步可能换模型/面/档位（步级属性不能当分组键，
 * 见 shared/usage.ts keyOfGroup）；步级身份看 `--last` 的逐步表。
 * `--last N` 同样生效（只统计最近 N 步）：两个模式的口径必须一致，
 * 否则"看最近几步的花费"换一个模式就给出别的数，比不支持还坏。
 */
export function renderUsageByAgent(steps: StepUsageRecord[], opts: UsageTableOpts = {}): string {
    const list = opts.last && opts.last > 0 ? steps.slice(-opts.last) : steps;
    const groups = groupByAgent(list);
    if (groups.length === 0) return "（还没有用量记录）";
    const header = ["人物", "步", "总输入(非缓存+读+写)", "总输出(文本+思考)", "非缓存$", "缓存读$", "缓存写$", "文本$", "思考$", "合计$", "单价依据"];
    const rows = groups.map((g) => [
        g.persona,
        String(g.stepCount),
        `${fmtTokens(g.buckets.inputTotal)}(${fmtTokens(g.buckets.noCache)}+${fmtTokens(g.buckets.cacheRead)}+${cellOpt(g.buckets.cacheWrite)})`,
        `${fmtTokens(g.buckets.outputTotal)}(${fmtTokens(g.buckets.text)}+${fmtTokens(g.buckets.reasoning)})`,
        g.cost ? fmtCost(g.cost.noCache) : "n/a",
        g.cost ? fmtCost(g.cost.cacheRead) : "n/a",
        g.cost?.cacheWrite == null ? "n/a" : fmtCost(g.cost.cacheWrite),
        g.cost ? fmtCost(g.cost.text) : "n/a",
        g.cost ? fmtCost(g.cost.reasoning) : "n/a",
        g.cost ? fmtCost(g.cost.total) : "n/a",
        g.tiers.length ? `tier=${g.tiers.join(",")}` : "—",
    ]);
    return table(header, rows);
}

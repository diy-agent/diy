/**
 * UsagePanel — 用量可见性的**三级收纳**（契约见任务 211 §六b；交互形态 2026-10-03 与用户对齐）：
 *
 *   L1 实时常显（页面只留一行数，大表一律藏进 L3）：
 *     · TurnUsageBar     —— turn 底 bar：`HH:MM · N tok · $X`（行是 flex 容器，后续可挂别的按钮）
 *     · SessionUsageChip —— 发送区人物右侧：会话累计 `N tok · $X`
 *   L2 hover 汇总卡：纵向 8 项（token 桶加总 + 输入$/输出$/合计$），
 *     卡顶 viewbar 右侧「明细」→ L3
 *   L3 drawer（覆盖页面）：本轮逐步明细 / 会话看板 —— 旧的两张表合成**一张双表头表**
 *     （原生 HTML `<table>` 的 colspan 分组行；md 表格语法做不了双表头，这里不是 md）
 *
 * 数字来源两条，**不许混**：
 *   · L1/L2 = turn 块属性（main 每步 patch，实时；会话数 = 各轮 attrs 累加，同为累计口径）
 *   · L3    = `<key>.usage.jsonl` 镜像（localChatStore.usage；开抽屉时对账刷新）
 *
 * 口径硬约束（##211 §一/§四，违者即口径事故）：
 *   · 总输入 = 非缓存输入 + 缓存读 + 缓存写；总输出 = 文本输出 + 思考输出（思考不另加价）
 *   · L1/L2 只放**累计口径**（各步累加，解释"花了多少"）；窗口% 是**最后一步**口径，只进 L3
 *     —— 两个口径不同框并排，是 ##231 相除误读（"986k 才 4%?"）的直接教训
 *   · 不可测桶写 `–`/`n/a`，**不写 0**；旧记录（无四桶字段）按原样降级，不假装能拆
 */

import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { localChatStore } from "../store/localChatStore";
import { useDrawerMax, DrawerMaxButton } from "./DrawerMaximize";
import {
    cacheHitRate,
    fmtCost,
    fmtInt,
    fmtTokens,
    groupByAgent,
    groupByTurn,
    stepView,
    sumBuckets,
    sumCosts,
    windowRate,
    type AgentGroup,
    type CostBreakdown,
    type StepUsageRecord,
    type TurnGroup,
    type TurnUsagePatch,
} from "../../shared/usage";
import type { BlockNode } from "../../main/services/local-blocks";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { notificationStore } from "../store/notificationStore";
import { DEFAULT_BUDGET_BYTES } from "../../shared/context/compaction";
import { useCompactPanel, CompactPanelContent } from "./CompactSessionPanel";
import type { CompactEventRecord, CompactTrigger } from "../../shared/context/compaction";
import { mapCompactPointsToSteps, stepKey } from "../../shared/context/compact-points";

// ─── 共用小件 ────────────────────────────────────────

/** 占用率文案；上限未知 → `—`（编一个百分比比留白更坏） */
function pctText(rate: number | null): string {
    return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/** 占用率配色：越高越危险（用户拿它决定何时重置，颜色是决策辅助不是装饰） */
function pctClass(rate: number | null): string {
    if (rate == null) return "opacity-60";
    if (rate >= 0.9) return "text-error";
    if (rate >= 0.75) return "text-warning";
    return "text-success";
}

/** 不可测桶 → `–`（与 0 区分：0 是"实测为零"这个另一个事实） */
const optCell = (n: number | null | undefined): string => (n == null ? "–" : fmtTokens(n));
const optCellInt = (n: number | null | undefined): string => (n == null ? "–" : fmtInt(n));

/** 各项金额总占比：v ÷ 表内总$（分母缺失/0 → –，不编 0%） */
const costShare = (v: number | null, total: number | null): string =>
    v == null || total == null || total <= 0 ? "–" : `${((v / total) * 100).toFixed(1)}%`;

function cellMs(ms: number | undefined): string {
    if (ms == null) return "–";
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const faceLabel = (api: string): string => (api === "responses" ? "resp" : "chat");

/**
 * 旧版 ops.jsonl 里的 usage 属性只有 {in,out,cached,total}（无四桶字段）。
 * 历史日志是 append-only 的史书，读侧必须兼容 —— 不当成"没有用量"，也不假装它是新格式。
 */
function isLegacyUsage(u: unknown): boolean {
    const r = u as Record<string, unknown> | null;
    return !!r && typeof r["noCache"] !== "number";
}

/** turnId（`t` + 13 位 epoch ms）→ `HH:MM`；旧格式 id 解析不出就不显示（不编时间） */
function fmtTurnClock(turnId: string): string | null {
    const m = /^t(\d{13})$/.exec(turnId);
    if (!m) return null;
    const d = new Date(Number(m[1]));
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── L2 汇总卡：统一数据模型（A/B 两表同一份源） ───────

/** L2 卡的模型：turn patch / session agg 都归一到它，A/B 两表从同一份数据渲染 */
interface UsageModel {
    /** 旧记录：只有 in/out/cached/total → 卡降级为 4 行简单列表 */
    legacy: boolean;
    /** 混有旧记录轮：文本/思考拆不开、金额为部分和（session 才会出现） */
    mixed: boolean;
    noCache: number | null;
    cacheRead: number | null;
    /** null = 该 API 面不可测（不是 0） */
    cacheWrite: number | null;
    inputTotal: number | null;
    text: number | null;
    reasoning: number | null;
    outputTotal: number | null;
    total: number | null;
    /** null = 无金额快照 */
    cost: CostBreakdown | null;
}

/** turn 块属性 → 卡模型 */
function turnUsageModel(usage: unknown): UsageModel {
    if (isLegacyUsage(usage)) {
        const l = usage as { in?: number; out?: number; cached?: number; total?: number };
        return {
            legacy: true, mixed: false,
            noCache: null, cacheRead: l.cached ?? null, cacheWrite: null,
            inputTotal: l.in ?? null, text: null, reasoning: null,
            outputTotal: l.out ?? null, total: l.total ?? null, cost: null,
        };
    }
    const p = usage as TurnUsagePatch;
    return {
        legacy: false, mixed: false,
        noCache: p.noCache, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite,
        inputTotal: p.inputTotal, text: p.text, reasoning: p.reasoning,
        outputTotal: p.outputTotal, total: p.total, cost: p.cost ?? null,
    };
}

/** 会话累计聚合（从块树各轮 attrs 累加，实时；与 L1 bar 同源同口径） */
export interface SessionUsageAgg {
    /** 携带 usage 的轮数（0 = 该会话没跑过带用量的轮次） */
    turns: number;
    legacyTurns: number;
    noCache: number;
    cacheRead: number;
    /** null = 至今没有任何一轮测到缓存写（不是 0） */
    cacheWrite: number | null;
    inputTotal: number;
    text: number;
    reasoning: number;
    outputTotal: number;
    total: number;
    /** null = 没有任何一轮有金额快照（不是 $0） */
    cost: CostBreakdown | null;
}

export function aggregateSessionUsage(trees: BlockNode[]): SessionUsageAgg {
    const a: SessionUsageAgg = {
        turns: 0, legacyTurns: 0, noCache: 0, cacheRead: 0, cacheWrite: null,
        inputTotal: 0, text: 0, reasoning: 0, outputTotal: 0, total: 0, cost: null,
    };
    const costs: CostBreakdown[] = [];
    for (const t of trees) {
        if (t.tag !== "turn") continue;
        const u = t.attrs.usage;
        if (!u) continue;
        a.turns++;
        if (isLegacyUsage(u)) {
            a.legacyTurns++;
            const l = u as { in?: number; out?: number; cached?: number; total?: number };
            const input = l.in ?? 0;
            const cached = l.cached ?? 0;
            a.inputTotal += input;
            a.outputTotal += l.out ?? 0;
            a.total += input + (l.out ?? 0);
            a.cacheRead += cached;
            a.noCache += Math.max(0, input - cached);
            continue;
        }
        const p = u as TurnUsagePatch;
        a.noCache += p.noCache;
        a.cacheRead += p.cacheRead;
        if (p.cacheWrite != null) a.cacheWrite = (a.cacheWrite ?? 0) + p.cacheWrite;
        a.inputTotal += p.inputTotal;
        a.text += p.text;
        a.reasoning += p.reasoning;
        a.outputTotal += p.outputTotal;
        a.total += p.total;
        if (p.cost) costs.push(p.cost);
    }
    a.cost = costs.length ? sumCosts(costs) : null;
    return a;
}

/** 会话累计 → 卡模型（turns=0 → null，卡走空态） */
function sessionUsageModel(a: SessionUsageAgg): UsageModel | null {
    if (a.turns === 0) return null;
    return {
        legacy: a.legacyTurns === a.turns,
        mixed: a.legacyTurns > 0 && a.legacyTurns < a.turns,
        noCache: a.noCache, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
        inputTotal: a.inputTotal, text: a.text, reasoning: a.reasoning,
        outputTotal: a.outputTotal, total: a.total, cost: a.cost,
    };
}

/** 输入侧金额 = 非缓存$ + 缓存读$ + 缓存写$（cost 缺 → null 不是 0） */
const inputCost = (m: UsageModel): number | null =>
    m.cost ? m.cost.noCache + m.cost.cacheRead + (m.cost.cacheWrite ?? 0) : null;
/** 输出侧金额 = 文本$ + 思考$（思考已含在总输出，此处只是拆解） */
const outputCost = (m: UsageModel): number | null => (m.cost ? m.cost.text + m.cost.reasoning : null);

/** 组内构成占比（part/whole）；任一缺失或 whole=0 → null（不编 0%） */
const innerFrac = (part: number | null | undefined, whole: number | null | undefined): number | null =>
    part != null && whole != null && whole > 0 ? part / whole : null;

/** 组内占比迷你条 + 百分数（0% 也给文本，条宽 0） */
function pctBar(f: number | null) {
    if (f == null) return <span class="opacity-40">–</span>;
    const w = f > 0 ? Math.max(1, Math.round(f * 100)) : 0;
    return (
        <span class="flex items-center gap-1">
            <span class="h-1.5 w-12 shrink-0 overflow-hidden rounded bg-base-300">
                <span class="block h-full bg-primary" style={{ width: `${w}%` }} />
            </span>
            <span class="tabular-nums opacity-70">{(f * 100).toFixed(1)}%</span>
        </span>
    );
}

/**
 * 树形分组表（2026-10-03 用户选定，替代 A/B 对比）——
 * 列：类型 | 词元 | 词元占比 | 花费 | 花费占比。
 * · **占比 = 总量占比**（子项 ÷ 总词元 / ÷ 总金额$）；**组行与合计不算占比**（防乱，2026-10-03）。
 * · 缺值符号**统一 `–`**（不可测 / n/a / 无值都是 –；语义靠 title 悬停说明，2026-10-03）。
 */
function UsageTableTree(props: { m: UsageModel }) {
    const m = () => props.m;
    const c = () => m().cost;
    const input$ = () => inputCost(m());
    const output$ = () => outputCost(m());
    /** 组行（总输入/总输出/合计）：只给词元与金额，占比两列留空 */
    const groupRow = (label: string, tokens: number | null, money: number | null, hint?: string) => (
        <tr class="font-medium">
            <td>{label}</td>
            <td class="text-right tabular-nums">{optCell(tokens)}</td>
            <td />
            <td class="text-right tabular-nums" title={hint}>{money == null ? "–" : `$${fmtCost(money)}`}</td>
            <td />
        </tr>
    );
    /** 子行：词元 + 总量词元占比 + 花费 + 总量花费占比 */
    const childRow = (
        label: string,
        tokens: number | null,
        tokHint: string | undefined,
        costV: number | null,
        costHint: string | undefined,
        tokFrac: number | null,
        costFrac: number | null,
    ) => (
        <tr title={costHint ?? tokHint}>
            <td class="pl-3 opacity-80" title={tokHint}>{label}</td>
            <td class="text-right tabular-nums" title={tokHint}>{optCell(tokens)}</td>
            <td>{pctBar(tokFrac)}</td>
            <td class="text-right tabular-nums" title={costHint ?? tokHint}>
                {c() == null || costV == null ? <span class="opacity-50">–</span> : `$${fmtCost(costV)}`}
            </td>
            <td>{c() == null || costV == null ? <span class="opacity-40">–</span> : pctBar(costFrac)}</td>
        </tr>
    );
    /** 总量占比的分母：词元 = 合计 total；花费 = 合计$（无金额 → null → 显示 –） */
    const totTok = () => m().total;
    const totCost = () => c()?.total ?? null;
    return (
        <table class="table table-xs w-full">
            <caption class="caption-bottom pt-1 text-left text-caption opacity-50">
                占比 = 总量占比（子项 ÷ 总词元 / ÷ 总金额$），只算子项；组行与合计不计占比
            </caption>
            <thead>
                <tr class="text-caption">
                    <th>类型</th>
                    <th class="text-right">词元</th>
                    <th title="该子项词元 ÷ 总词元">词元占比</th>
                    <th class="text-right">花费</th>
                    <th title="该子项金额 ÷ 总金额$">花费占比</th>
                </tr>
            </thead>
            <tbody class="text-body">
                {groupRow("总输入", m().inputTotal, input$(), "= 非缓存 + 缓存读 + 缓存写 的金额")}
                {childRow(
                    "├ 非缓存输入", m().noCache, "未命中前缀缓存、按全价计（本轮各步累计）",
                    c()?.noCache ?? null, "非缓存输入金额",
                    innerFrac(m().noCache, totTok()), innerFrac(c()?.noCache ?? null, totCost()),
                )}
                {childRow(
                    "├ 缓存读", m().cacheRead, "暖输入，按缓存读单价计（本轮各步累计）",
                    c()?.cacheRead ?? null, "缓存读金额",
                    innerFrac(m().cacheRead, totTok()), innerFrac(c()?.cacheRead ?? null, totCost()),
                )}
                {childRow(
                    "└ 缓存写", m().cacheWrite,
                    m().cacheWrite == null ? "该 API 面不可测（不是 0；符号 –）" : "写入前缀缓存（本轮各步累计）",
                    c()?.cacheWrite ?? null,
                    c()?.cacheWrite == null ? "该 API 面不可测（不是 0；符号 –）" : "缓存写金额",
                    innerFrac(m().cacheWrite, totTok()), innerFrac(c()?.cacheWrite ?? null, totCost()),
                )}
                {groupRow("总输出", m().outputTotal, output$(), "= 文本 + 思考 的金额（思考不另加价）")}
                <Show when={!m().mixed} fallback={
                    <tr>
                        <td class="pl-3 opacity-80" colSpan={5} title="混有旧记录轮，文本/思考拆不开">└ 文本 / 思考 — 混有旧记录轮，不拆分</td>
                    </tr>
                }>
                    {childRow(
                        "├ 文本输出", m().text, "总输出的子集",
                        c()?.text ?? null, "文本输出金额",
                        innerFrac(m().text, totTok()), innerFrac(c()?.text ?? null, totCost()),
                    )}
                    {childRow(
                        "└ 思考输出", m().reasoning, "= AI SDK reasoningTokens；总输出的子集，计价不另加",
                        c()?.reasoning ?? null, "思考输出金额（已含在 output 单价里，此处为拆解展示）",
                        innerFrac(m().reasoning, totTok()), innerFrac(c()?.reasoning ?? null, totCost()),
                    )}
                </Show>
                {groupRow("合计", m().total, c()?.total ?? null, m().mixed ? "混有旧记录轮，为部分和" : "各步按当时生效单价计算后相加")}
            </tbody>
        </table>
    );
}

/** 旧记录降级：四桶/金额都拆不出，只给 4 行简单列表（不假装能拆） */
function LegacyRows(props: { m: UsageModel }) {
    return (
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
            <dt class="opacity-60">总输入</dt><dd class="text-right tabular-nums" title="旧记录：无四桶拆分">{optCell(props.m.inputTotal)}</dd>
            <dt class="opacity-60">总输出</dt><dd class="text-right tabular-nums" title="旧记录：无四桶拆分">{optCell(props.m.outputTotal)}</dd>
            <dt class="opacity-60">缓存读</dt><dd class="text-right tabular-nums">{optCell(props.m.cacheRead)}</dd>
            <dt class="opacity-60">Σ 合计</dt><dd class="text-right tabular-nums">{optCell(props.m.total)}</dd>
        </dl>
    );
}


// ─── 窗口占用环（L1 常显 + L2 卡顶；数据 = turn patch 的最后一步口径） ───

/**
 * 会话**当前**窗口占用：取 id 最新、且带 contextLimit 的 turn 的最后一步窗口
 * （turn patch 每步实时推 `windowTotal/contextLimit`，与 L3 账本同源同口径）。
 * 找不到 → null（不编 0%）。
 */
function currentWindow(
    trees: BlockNode[],
): {
    total: number;
    contextLimit: number;
    rate: number;
    prompt: number | null;
    parts: { systemBytes: number; toolsBytes: number } | null;
} | null {
    type W = { total: number; contextLimit: number; rate: number; prompt: number | null; parts: { systemBytes: number; toolsBytes: number } | null };
    let best: W | null = null;
    let bestId = -1;
    for (const t of trees) {
        if (t.tag !== "turn") continue;
        const u = t.attrs.usage as TurnUsagePatch | undefined;
        if (!u || u.contextLimit == null) continue;
        const n = Number(String(t.id).replace(/^t/, ""));
        if (!Number.isFinite(n) || n < bestId) continue;
        bestId = n;
        // prompt = 最后一步输入（账本精确）；老记录缺字段 → null（构成行降级为 –）
        const prompt = u.lastInputTotal ?? (u.lastOutputTotal != null ? u.windowTotal - u.lastOutputTotal : null);
        best = { total: u.windowTotal, contextLimit: u.contextLimit, rate: u.windowTotal / u.contextLimit, prompt, parts: u.contextParts ?? null };
    }
    return best;
}

/**
 * 环的五档色（2026-10-03 用户定）：<20% 主色 · ≥20% 黄 · ≥40% 粉 · ≥60% 淡红 · ≥80% 红。
 * 粉/淡红没有 daisyUI 语义色，用 tailwind 色阶（pink-400 / red-300）。
 */
const ringClass = (rate: number): string =>
    rate >= 0.8 ? "text-error"
    : rate >= 0.6 ? "text-red-300"
    : rate >= 0.4 ? "text-pink-400"
    : rate >= 0.2 ? "text-warning"
    : "text-primary";

/** 环的 --value（0-100，留一位小数） */
const ringValue = (rate: number): string => String(Math.min(100, Math.round(rate * 1000) / 10));

/**
 * 环形进度：**底轨（浅色全环）+ 进度环叠放** —— daisyUI radial-progress 的轨道是透明的
 * （conic-gradient 进度外是 #0000），单放一个在浅底上只有进度段、看不见空环（2026-10-03 修正）。
 */
function RingBar(props: { rate: number; size: string; thickness: string; center?: string; label?: string }) {
    const base = `--value:100;--size:${props.size};--thickness:${props.thickness}`;
    const prog = `--value:${ringValue(props.rate)};--size:${props.size};--thickness:${props.thickness}`;
    return (
        <div
            class="relative shrink-0"
            style={{ width: props.size, height: props.size }}
            role="progressbar"
            aria-label={props.label ?? "窗口占用"}
            aria-valuenow={Math.round(props.rate * 100)}
        >
            <div class="radial-progress absolute left-0 top-0 text-base-300" style={base} />
            <div class={`radial-progress absolute left-0 top-0 ${ringClass(props.rate)}`} style={prog} />
            <Show when={props.center != null}>
                <span class="absolute inset-0 flex items-center justify-center text-caption font-medium tabular-nums">
                    {props.center}
                </span>
            </Show>
        </div>
    );
}

/**
 * 构成三段导出（dsh 的 contextBreakdown 同型）：
 * · 系统提示词/工具定义 = 真发字节 ÷ 4（估算，标 ~）
 * · 历史消息 = 该步 prompt（账本精确）− 上两段估算（减法；含 runtime 尾部消息、工具输出）
 * 三者缺数据（本版前的老记录）→ null → UI 显示 `–`，不编 0。
 */
function partsOf(x: {
    prompt: number | null;
    parts: { systemBytes: number; toolsBytes: number } | null;
}): { system: number | null; tools: number | null; messages: number | null; prompt: number | null } {
    if (!x.parts) return { system: null, tools: null, messages: null, prompt: x.prompt };
    const system = Math.round(x.parts.systemBytes / 4);
    const tools = Math.round(x.parts.toolsBytes / 4);
    const messages = x.prompt == null ? null : Math.max(0, x.prompt - system - tools);
    return { system, tools, messages, prompt: x.prompt };
}

/** `YYYY-MM-DD HH:MM:SS`（本地时区）；非法日期 → 空串（调用方回退原文） */
const fmtDateSec = (d: Date | number): string => {
    const dt = typeof d === "number" ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
};

/** 轮次时间（日期 + 时间到秒）：turnId 自带 epoch ms（`t179…`）；非常规 id → null（回退原 id） */
const turnStamp = (turnId: string): string | null => {
    const m = /^t(\d{13})$/.exec(turnId);
    if (!m) return null;
    const s = fmtDateSec(Number(m[1]));
    return s || null;
};

/** 步时间（日期 + 时间到秒）：账本 ts（ISO）；非法 → 原文 */
const stepStamp = (ts: string): string => fmtDateSec(new Date(ts)) || ts;

/** 构成数量格：`~N`（字节÷4 估）；缺数据 → – */
const numCell = (v: number | null) =>
    v == null ? <span class="opacity-50">–</span> : <span class="tabular-nums">~{fmtTokens(v)}</span>;

/** 占比格：该段 ÷ 同行 prompt；缺数据 → –（与数量分列展示，2026-10-03 用户定） */
const pctCell = (v: number | null, prompt: number | null) =>
    v == null || !prompt ? (
        <span class="opacity-50">–</span>
    ) : (
        <span class="tabular-nums">{((v / prompt) * 100).toFixed(1)}%</span>
    );

/**
 * L1 窗口占用环：发送区会话 chip 右侧（token/金额总量右边）。
 * · 环 = RingBar（底轨 + 五档色）；% 与环同侧。
 * · hover 弹构成卡（三段估算 + 总量精确）；卡上「明细 →」打开构成报表（总/分两表）。
 * 数据链：turn patch 的 contextParts（main 每步真发时记字节）+ 账本 prompt —— 不做 hover 现算。
 */
export function WindowRing() {
    const w = () => currentWindow(localChatStore.trees);
    /** 无数据也显示环（0%）—— 用户 2026-10-07：「无数据时应显示 0%」，不是整块消失 */
    const win = () => w() ?? { total: 0, contextLimit: 0, rate: 0, prompt: null, parts: null };
    const [open, setOpen] = createSignal(false);
    const [drawerOpen, setDrawerOpen] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    /** 直接压缩一次（用当前配置的预算）—— 用户 2026-10-07「点后直接压缩，不要弹到详情页」 */
    const apply = async () => {
        const u = localChatStore.currentUri;
        if (!u) return;
        setBusy(true);
        try {
            await localChatStore.compact(u, { budgetBytes: budget() ?? DEFAULT_BUDGET_BYTES } as never);
            notificationStore.addToast("success", "已压缩（历史保留、可撤销）");
            setOpen(false);
        } catch (e) {
            notificationStore.addToast("error", String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };
    const [anchor, setAnchor] = createSignal<{ left: number; top: number } | null>(null);
    let closeT: ReturnType<typeof setTimeout> | undefined;

    /** 当前生效预算（字节）—— 取配置真源 `auto-compact.yaml` 的 policy.modeData.budgetBytes */
    const [budget] = createResource(() => localChatStore.currentUri, async (u) => {
        if (!u) return null;
        const st = (await localChatStore.autoCompactStatus(u)) as {
            config?: { policy?: { modeData?: { budgetBytes?: number }; budgetBytes?: number } };
        };
        const p = st?.config?.policy;
        const bb = p?.modeData?.budgetBytes ?? p?.budgetBytes;
        return typeof bb === "number" ? bb : null;
    });
    /** 压缩后估算 token：固定开支（system+工具）+ 预算内历史 */
    const afterTokens = (): number | null => {
        const p = partsOf(win());
        const fixed = (p.system ?? 0) + (p.tools ?? 0);
        const b = budget();
        if (b == null) return null;
        return fixed + Math.round(b / 4);
    };

    const openCard = (el: HTMLElement) => {
        if (closeT !== undefined) clearTimeout(closeT);
        const r = el.getBoundingClientRect();
        setAnchor({ left: Math.round(r.left), top: Math.round(r.top) });
        setOpen(true);
    };
    const armClose = () => {
        if (closeT !== undefined) clearTimeout(closeT);
        closeT = setTimeout(() => setOpen(false), 160);
    };
    onCleanup(() => closeT !== undefined && clearTimeout(closeT));

    return (
        <>
            <button
                type="button"
                class="flex cursor-pointer items-center gap-1 rounded px-0.5 transition-opacity hover:opacity-80"
                aria-label="窗口占用（悬停看构成与压缩，点击开窗口构成报表）"
                aria-haspopup="dialog"
                title={`当前上下文 ${fmtTokens(win().total)} / ${fmtTokens(win().contextLimit)}（最后一步 总输入+总输出 ÷ 窗口上限），距上限还有 ${fmtTokens(Math.max(0, win().contextLimit - win().total))}。悬停看构成，点击打开按轮/按步报表`}
                onPointerEnter={(e) => openCard(e.currentTarget)}
                onPointerLeave={armClose}
                onClick={() => {
                    setOpen(false);
                    setDrawerOpen(true);
                }}
            >
                <RingBar rate={win().rate} size="1.5rem" thickness="3px" />
                <span class="text-body tabular-nums opacity-70">{pctText(win().rate)}</span>
            </button>
            <Show when={open() && anchor()}>
                <Portal>
                    <div
                        class="fixed z-[70] w-72 rounded-box border border-base-300 bg-base-100 shadow-2xl"
                        style={{
                            left: `${Math.min(Math.max(8, anchor()!.left), Math.max(8, window.innerWidth - 296))}px`,
                            bottom: `${window.innerHeight - anchor()!.top + 8}px`,
                        }}
                        onPointerEnter={() => closeT !== undefined && clearTimeout(closeT)}
                        onPointerLeave={armClose}
                    >
                        <div class="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-1.5">
                            <span class="text-body font-medium">上下文构成 · 估算</span>
                            <button
                                type="button"
                                class="btn btn-ghost btn-xs"
                                onClick={() => {
                                    setOpen(false);
                                    setDrawerOpen(true);
                                }}
                            >
                                明细 ›
                            </button>
                        </div>
                        <div class="grid grid-cols-[auto_1fr_auto] gap-x-3 px-3 pt-2 text-caption opacity-40">
                            <span />
                            <span class="block text-right">数量</span>
                            <span class="block text-right">占比</span>
                        </div>
                        <dl class="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 px-3 py-1 text-body">
                            {(() => {
                                const p = partsOf(win());
                                const pct = (v: number | null) =>
                                    v == null || p.prompt == null ? (
                                        <span class="opacity-40">–</span>
                                    ) : (
                                        <span class="tabular-nums">{((v / p.prompt) * 100).toFixed(1)}%</span>
                                    );
                                const row = (label: string, v: number | null, hint: string) => (
                                    <>
                                        <dt class="opacity-60" title={hint}>{label}</dt>
                                        <dd class="text-right tabular-nums" title={hint}>
                                            {v == null ? <span class="opacity-50">–</span> : `~${fmtTokens(v)}`}
                                        </dd>
                                        <dd class="text-right" title="该段 ÷ prompt（账本精确）">{pct(v)}</dd>
                                    </>
                                );
                                return (
                                    <>
                                        <dt class="opacity-60" title="最后一步 总输入+总输出 ÷ 上限（账本精确，与环同源）">当前 / 上限</dt>
                                        <dd class="text-right tabular-nums">
                                            {fmtTokens(win().total)} / {fmtTokens(win().contextLimit)}
                                        </dd>
                                        <dd class="text-right opacity-40">—</dd>
                                        {row("系统提示词", p.system, "真发 system 容器字节 ÷ 4（估算）")}
                                        {row("工具定义", p.tools, "真发 tools 定义 JSON 字节 ÷ 4（估算）")}
                                        {row("历史消息", p.messages, "该步 prompt（账本精确）− 系统 − 工具（含 runtime 消息与工具输出）")}
                                    </>
                                );
                            })()}
                        </dl>

                        {/* ── 压缩：卡上只给「压缩」按钮 + 可降低窗口的比较条（参数调整在窗口构成页）── */}
                        <div class="border-t border-base-300 px-3 py-2">
                                <div class="mb-1.5 text-caption opacity-60">压缩（降低历史占用，历史不删）</div>
                                {(() => {
                                    const cur = win().total;
                                    const aft = afterTokens();
                                    const max = Math.max(1, cur, aft ?? 0);
                                    const w1 = `${Math.min(100, (cur / max) * 100).toFixed(1)}%`;
                                    const w2 = aft == null ? "0%" : `${Math.min(100, (aft / max) * 100).toFixed(1)}%`;
                                    const saved = aft == null ? null : Math.max(0, cur - aft);
                                    return (
                                        <div class="mb-2 space-y-1 text-caption">
                                            <div>
                                                <div class="flex justify-between"><span>当前</span><span class="tabular-nums opacity-70">{fmtTokens(cur)}</span></div>
                                                <div class="mt-0.5 h-2.5 rounded bg-base-200 overflow-hidden">
                                                    <div data-cost-bar class="h-full bg-base-content/35" style={{ width: w1 }} />
                                                </div>
                                            </div>
                                            <div>
                                                <div class="flex justify-between"><span>压缩后</span><span class="tabular-nums opacity-70">{aft == null ? "–" : fmtTokens(aft)}</span></div>
                                                <div class="mt-0.5 h-2.5 rounded bg-base-200 overflow-hidden">
                                                    <div data-cost-bar class="h-full bg-primary" style={{ width: w2 }} />
                                                </div>
                                            </div>
                                            <div class="pt-0.5">
                                                {saved == null ? (
                                                    <span class="opacity-50">–</span>
                                                ) : saved > 0 ? (
                                                    <span class="text-success" data-cost-saved>可降 {fmtTokens(saved)}</span>
                                                ) : (
                                                    <span class="opacity-50" data-cost-saved>无可降（预算未生效）</span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}
                                <button
                                    type="button"
                                    class="btn btn-primary btn-xs w-full"
                                    aria-label="压缩会话上下文"
                                    disabled={busy()}
                                    title="压缩会话上下文（历史保留、可撤销）；参数调整在窗口构成页"
                                    onClick={() => void apply()}
                                >
                                    {busy() ? "压缩中…" : "压缩"}
                                </button>
                            </div>

                        <div class="border-t border-base-300 px-3 py-1 text-caption opacity-50">
                            ~ = 字节 ÷ 4 估算；占比 = 该段 ÷ prompt；– = 该轮未落盘构成（本版前的记录）
                        </div>
                    </div>
                </Portal>
            </Show>
            <ContextPartsDrawer open={drawerOpen()} onClose={() => setDrawerOpen(false)} />
        </>
    );
}

/**
 * L3 窗口构成报表 —— 回答「为 agent 优化该动谁」：系统提示词多了？历史消息多了？工具输出多了？
 * 与用量看板（钱 vs 模型，判断价格变化）是**两个问题**，数据同账本、不同列（2026-10-03 定位）。
 * · 总表 = 按轮列表（轮时间到秒 + 轮 id；构成数量 3 列 + 占比 3 列独立；不带末步 prompt/窗口）
 * · 分表 = 按步列表（步时间到秒 + 轮 id + 该步 prompt 与执行时窗口 + 压缩点位；数量/占比同样 3+3）
 * 单元格口径：数量 = 字节÷4 估（~）；占比 = 该段 ÷ 同行 prompt；– = 未落盘构成（本版前的记录）。
 */
export function ContextPartsDrawer(props: { open: boolean; onClose: () => void }) {
    const [view, setView] = createSignal<"compact" | "total" | "step">("compact");
    // 打开对账一次账本 + Escape 自管（stopPropagation：别把别的抽屉连带关了）
    createEffect(() => {
        if (!props.open) return;
        const u = localChatStore.currentUri;
        if (u) void localChatStore.refreshUsage(u);
        void refetchCompactEvents();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                props.onClose();
            }
        };
        document.addEventListener("keydown", onKey, true);
        onCleanup(() => document.removeEventListener("keydown", onKey, true));
    });
    const steps = () => localChatStore.usage;
    const groups = () => groupByTurn(steps());
    /** 压缩面板控制器（供 tab 栏执行按钮 + 压缩 tab 内容共享） */
    const ctl = useCompactPanel(() => localChatStore.currentUri ?? "");

    // ─── M4：压缩点位（分表按步标注「哪次请求被压过」）───
    // 【用户 2026-10-08】压缩可能发生在**一轮中间** ⇒ 用**轮次总表**表达不了「哪个请求压过」，
    // 必须落在**分表（按步）**：一步 = 一次请求。判据 = 该步 ts 是该压缩事件之后的**第一步**。
    const [compactEvents, { refetch: refetchCompactEvents }] = createResource(
        () => (props.open ? localChatStore.currentUri : null),
        async (u) => (u ? ((await localChatStore.compactEvents(u)) as CompactEventRecord[]) : []),
    );
    /** 展开的压缩点位（键 = `<turnId>#<step>`；同时只开一个） */
    const [openPoint, setOpenPoint] = createSignal<string | null>(null);
    /** 步键 → 该步命中的压缩事件（按 ts 升序；可能多条）。纯函数在 shared（可单测）。 */
    const compactPoints = createMemo(() => mapCompactPointsToSteps(steps(), compactEvents() ?? []));
    const fmtB = (n?: number) => (n === undefined ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
    const byText = (by: CompactEventRecord["by"]) => (by === "auto" ? "自动" : by === "ui" ? "界面" : "命令行");
    const triggerShort = (t: CompactTrigger) =>
        t === "systemContextChanged" ? "系统上下文变" : t === "cacheExpired" ? "缓存过期" : t === "contextWindowOver" ? "窗口超限" : "手动";

    /** 一行的三段（cp = 该行记录的构成字节；prompt = 该行输入 token，精确） */
    const rowParts = (cp: { systemBytes: number; toolsBytes: number } | undefined, prompt: number) => {
        if (!cp) return { system: null, tools: null, messages: null, prompt };
        const system = Math.round(cp.systemBytes / 4);
        const tools = Math.round(cp.toolsBytes / 4);
        return { system, tools, messages: Math.max(0, prompt - system - tools), prompt };
    };

    /** 一行的构成 6 格：数量 3 列 + 占比 3 列（分组表头两组各 3） */
    const cellsOf = (cp: { systemBytes: number; toolsBytes: number } | undefined, prompt: number) => {
        const p = rowParts(cp, prompt);
        return (
            <>
                <td class="text-right">{numCell(p.system)}</td>
                <td class="text-right">{numCell(p.tools)}</td>
                <td class="text-right">{numCell(p.messages)}</td>
                <td class="text-right">{pctCell(p.system, prompt)}</td>
                <td class="text-right">{pctCell(p.tools, prompt)}</td>
                <td class="text-right">{pctCell(p.messages, prompt)}</td>
            </>
        );
    };

    /** 分组表头（两行：跨行键列 + 数量/占比两组）；两表共用 */
    const headRows = (keyCols: { label: string; cls?: string; title?: string }[], tailCols: { label: string; title?: string }[]) => (
        <>
            <tr class="text-caption">
                {keyCols.map((c) => (
                    <th rowspan={2} class={c.cls ?? ""} title={c.title}>{c.label}</th>
                ))}
                <th colspan={3} class="text-center font-medium opacity-60" title="真发字节 ÷ 4 估算（标 ~）">构成数量</th>
                <th colspan={3} class="text-center font-medium opacity-60" title="该段 ÷ 同行 prompt">占比</th>
                {tailCols.map((c) => (
                    <th rowspan={2} class="text-right" title={c.title}>{c.label}</th>
                ))}
            </tr>
            <tr class="text-caption">
                <th class="text-right">系统提示词</th>
                <th class="text-right">工具定义</th>
                <th class="text-right">历史消息</th>
                <th class="text-right">系统%</th>
                <th class="text-right">工具%</th>
                <th class="text-right">消息%</th>
            </tr>
        </>
    );

    /** 总表合计（含老轮 → 部分和，title 注明） */
    const totals = () => {
        let prompt = 0, system = 0, tools = 0, messages = 0;
        for (const g of groups()) {
            const p = rowParts(g.last.record.contextParts, g.last.buckets.inputTotal);
            prompt += p.prompt;
            if (p.system != null) { system += p.system; tools += p.tools!; }
            if (p.messages != null) messages += p.messages;
        }
        return { prompt, system, tools, messages };
    };
    const partial = () => groups().some((g) => !g.last.record.contextParts);
    const partialHint = partial() ? "部分和：仅含已落盘构成的轮（本版前的老轮不计）" : undefined;

    const DM = useDrawerMax();
    return (
        <Show when={props.open}>
            {/* 与用量抽屉同构：全宽贴顶、高 2/3 屏；点遮罩 / ✕ / Escape 退出 */}
            <div class="fixed inset-0 z-50 flex flex-col" onClick={props.onClose}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl" style={DM.style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="truncate text-title font-medium">
                            窗口构成
                            <span class="ml-2 text-body font-normal opacity-60">为 agent 优化：该动谁（提示词 / 历史 / 工具）</span>
                        </div>
                        <div class="join ml-auto shrink-0" role="group" aria-label="窗口构成视图">
                            <button
                                class={`btn btn-xs join-item ${view() === "compact" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={view() === "compact"}
                                onClick={() => setView("compact")}
                            >
                                压缩
                            </button>
                            <button
                                class={`btn btn-xs join-item ${view() === "total" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={view() === "total"}
                                onClick={() => setView("total")}
                            >
                                总表（按轮）
                            </button>
                            <button
                                class={`btn btn-xs join-item ${view() === "step" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={view() === "step"}
                                onClick={() => setView("step")}
                            >
                                分表（按步）
                            </button>
                        </div>
                        <button
                            class="btn btn-primary btn-xs shrink-0"
                            aria-label="压缩（详情页）"
                            disabled={ctl.busy()}
                            title="压缩会话上下文（历史保留、可撤销）"
                            onClick={() => void ctl.apply()}
                        >
                            {ctl.busy() ? "压缩中…" : "压缩"}
                        </button>
                        <DrawerMaxButton max={DM.max()} onToggle={DM.toggle} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose} aria-label="关闭窗口构成">
                            ✕
                        </button>
                    </div>
                    <Show
                        when={view() !== "compact"}
                        fallback={
                            <div class="min-h-0 flex-1 overflow-hidden">
                                <CompactPanelContent ctl={ctl} />
                            </div>
                        }
                    >
                    <div class="min-h-0 flex-1 overflow-auto p-4">
                        <Show
                            when={steps().length > 0}
                            fallback={<div class="text-body opacity-60">还没有用量记录（跑一轮后每步写入账本）。</div>}
                        >
                            <Show
                                when={view() === "total"}
                                fallback={
                                    /* 分表：每步一行（步时间到秒 + 轮 id + 该步 prompt 与执行时窗口 + 数量/占比 3+3） */
                                    <div class="overflow-x-auto rounded-box border border-base-300 bg-base-100 p-2">
                                        <table class="table table-xs w-full whitespace-nowrap">
                                            <thead>
                                                {headRows(
                                                    [
                                                        { label: "时间（到秒）", cls: "text-right" },
                                                        { label: "轮次 id", cls: "text-right" },
                                                        { label: "步", cls: "text-right" },
                                                        { label: "该步 prompt", cls: "text-right", title: "该步总输入（账本精确）" },
                                                    ],
                                                    [
                                                        { label: "窗口%", title: "该步 总输入+总输出 ÷ 上限（执行时的窗口情况）" },
                                                        { label: "压缩", title: "该步（请求）是否被压缩过 —— 点击展开那次压缩信息" },
                                                    ],
                                                )}
                                            </thead>
                                            <tbody>
                                                <For each={steps()}>
                                                    {(r) => {
                                                        const v = stepView(r);
                                                        const k = stepKey(r);
                                                        const evs = () => compactPoints().get(k);
                                                        return (
                                                            <>
                                                                <tr>
                                                                    <td class="text-right tabular-nums" title={r.ts}>{stepStamp(r.ts)}</td>
                                                                    <td class="text-right font-mono text-caption opacity-70">{r.turnId}</td>
                                                                    <td class="text-right tabular-nums">s{r.step}</td>
                                                                    <td class="text-right tabular-nums">{fmtInt(v.buckets.inputTotal)}</td>
                                                                    {cellsOf(r.contextParts, v.buckets.inputTotal)}
                                                                    <td class={`text-right ${pctClass(v.windowRate)}`}>{pctText(v.windowRate)}</td>
                                                                    <td class="text-right">
                                                                        <Show when={evs()} fallback={<span class="opacity-30">—</span>}>
                                                                            {(list) => (
                                                                                <button
                                                                                    class="btn btn-ghost btn-xs text-info"
                                                                                    aria-label="压缩点位"
                                                                                    data-compact-point
                                                                                    onClick={() => setOpenPoint((cur) => (cur === k ? null : k))}
                                                                                >
                                                                                    压缩{list().length > 1 ? ` ×${list().length}` : ""}
                                                                                </button>
                                                                            )}
                                                                        </Show>
                                                                    </td>
                                                                </tr>
                                                                <Show when={openPoint() === k && evs()}>
                                                                    <tr data-compact-point-detail>
                                                                        <td colspan={12} class="bg-base-200/60 p-2">
                                                                            <div class="space-y-1 text-caption">
                                                                                <For each={evs() ?? []}>
                                                                                    {(ev) => (
                                                                                        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                                                                                            <span class="badge badge-ghost badge-xs">budget</span>
                                                                                            <span>
                                                                                                上限{" "}
                                                                                                {ev.policy.modeData.budgetBytes === 0
                                                                                                    ? "0（=清零）"
                                                                                                    : `${Math.round(ev.policy.modeData.budgetBytes / 1024)} KB`}
                                                                                            </span>
                                                                                            <span>{byText(ev.by)} · {triggerShort(ev.trigger)}</span>
                                                                                            <span class="tabular-nums">轮 {ev.size.before.turns} → {ev.size.after.turns}</span>
                                                                                            <span class="tabular-nums">字节 {fmtB(ev.size.before.bytes)} → {fmtB(ev.size.after.bytes)}</span>
                                                                                            <span>保留区间 {(ev.details?.kept ?? []).length} 段</span>
                                                                                            <span class="opacity-50">{new Date(ev.ts).toLocaleString()}</span>
                                                                                        </div>
                                                                                    )}
                                                                                </For>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </Show>
                                                            </>
                                                        );
                                                    }}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                }
                            >
                                {/* 总表：每轮一行（轮时间到秒 + 轮 id；不带末步 prompt/窗口，2026-10-03 用户定） */}
                                <div class="overflow-x-auto rounded-box border border-base-300 bg-base-100 p-2">
                                    <table class="table table-xs w-full whitespace-nowrap">
                                        <thead>
                                            {headRows(
                                                [
                                                    { label: "时间（到秒）", cls: "text-right" },
                                                    { label: "轮次 id", cls: "text-right" },
                                                    { label: "步", cls: "text-right" },
                                                ],
                                                [],
                                            )}
                                        </thead>
                                        <tbody>
                                            <For each={groups()}>
                                                {(g) => (
                                                    <tr>
                                                        <td class="text-right tabular-nums" title={g.turnId}>{turnStamp(g.turnId) ?? g.turnId}</td>
                                                        <td class="text-right font-mono text-caption opacity-70">{g.turnId}</td>
                                                        <td class="text-right">{g.steps.length}</td>
                                                        {cellsOf(g.last.record.contextParts, g.last.buckets.inputTotal)}
                                                    </tr>
                                                )}
                                            </For>
                                        </tbody>
                                        <tfoot>
                                            <tr class="font-medium">
                                                <td class="opacity-70" title={partialHint}>合计{partial() ? "（部分和）" : ""}</td>
                                                <td />
                                                <td class="text-right">{groups().reduce((s, g) => s + g.steps.length, 0)}</td>
                                                <td class="text-right">{numCell(totals().system)}</td>
                                                <td class="text-right">{numCell(totals().tools)}</td>
                                                <td class="text-right">{numCell(totals().messages)}</td>
                                                <td class="text-right" title={partialHint}>{pctCell(totals().system, totals().prompt)}</td>
                                                <td class="text-right" title={partialHint}>{pctCell(totals().tools, totals().prompt)}</td>
                                                <td class="text-right" title={partialHint}>{pctCell(totals().messages, totals().prompt)}</td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            </Show>
                            <div class="mt-2 text-caption opacity-60">
                                ~ = 字节 ÷ 4 估算（中英混排会偏差）；历史消息 = 同行 prompt（账本精确）− 系统 − 工具；
                                占比 = 该段 ÷ 同行 prompt（合计 = Σ段 ÷ Σprompt）。
                                <br />
                                `–` = 该记录未落盘构成（本版前的旧轮）；窗口% = 该步 总输入+总输出 ÷ 上限（与环同源）；
                                压缩列 = 该步（请求）是否被压缩过（点开看那次的算法/过滤器/规模）。
                            </div>
                        </Show>
                    </div>
                    </Show>
                </div>
            </div>
        </Show>
    );
}

// ─── L2 hover 计时（模块级：bar 与卡跨组件共享，重建不丢） ───

let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;

/** 取消"延迟关闭"（指针进入 bar 或卡） */
export function cancelHoverClose(): void {
    if (hoverCloseTimer !== undefined) {
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = undefined;
    }
}

/** 延迟关闭（指针离开 bar 且未进入卡：给 160ms 跨过间隙） */
export function armHoverClose(close: () => void): void {
    cancelHoverClose();
    hoverCloseTimer = setTimeout(() => {
        hoverCloseTimer = undefined;
        close();
    }, 160);
}

/** hover 卡的打开状态（存页面级，块树重建不丢；坐标供 Portal 定位） */
export interface UsageHoverState {
    /** turnId 或 "session" */
    id: string;
    /** 触发元素（其所属块树可能每帧重建：重建后 isConnected=false，位置沿用打开时的值） */
    anchor: HTMLElement;
    left: number;
    top: number;
    bottom: number;
    /** 打开时上方放不下 → 翻到下方 */
    above: boolean;
}

// ─── L2 汇总卡（Portal + viewport fixed：滚动容器裁不到它） ───

/** 卡宽：A 树形表约 400px、B 双栏表约 440px —— 取 440 放下两个方案 */
const CARD_W = 448;

export function UsageHoverCard(props: {
    state: UsageHoverState | null;
    onEnter: () => void;
    onLeave: () => void;
    /** "session" 或 turnId */
    onDetail: (id: string) => void;
}) {
    const [pos, setPos] = createSignal<{ left: number; above: boolean; edge: number } | null>(null);
    createEffect(() => {
        const s = props.state;
        setPos(s ? { left: s.left, above: s.above, edge: s.above ? s.top : s.bottom } : null);
    });
    onCleanup(() => cancelHoverClose());

    let el: HTMLDivElement | undefined;
    /**
     * 把卡完整夹进视口 —— A/B 双表后卡高约 580px（旧 ~250px 的 `r.top > 280` 翻转
     * 阈值已不够用：视口中段触发时上下都放不下）。
     * 优先贴触发边（上/下），放不下就整体回拉到视口内；配合 max-h 保证任何窗口高度下都不出屏。
     * 直接写 DOM style，不进响应式系统 → 不会与渲染互相触发。
     */
    const clampToViewport = (): void => {
        const p = pos();
        if (!el || !p) return;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        el.style.left = `${Math.min(Math.max(8, p.left), Math.max(8, vw - CARD_W - 8))}px`;
        const below = p.edge + 8; // 触发边下方
        const above = p.edge - 8 - h; // 触发边上方
        const top =
            p.above && above >= 8
                ? above
                : below + h <= vh - 8
                  ? below
                  : Math.max(8, Math.min(below, vh - h - 8)); // 两头都放不下 → 夹进视口
        el.style.top = `${top}px`;
        el.style.bottom = "";
    };
    // 下一帧再夹紧：ref 回调时元素尚未插入文档，offsetHeight 量不到；rAF 时必已插入。
    // 只在 pos 变化时调度（卡高变化由 max-h 兜底，不逐帧轮询）。
    let clampRaf = 0;
    createEffect(() => {
        pos();
        cancelAnimationFrame(clampRaf);
        clampRaf = requestAnimationFrame(clampToViewport);
    });
    onCleanup(() => cancelAnimationFrame(clampRaf));

    /** A/B 两表同一份源（2026-10-03 对比期：两方案同卡并列，选定后删其一） */
    const model = (): UsageModel | null => {
        const s = props.state;
        if (!s) return null;
        if (s.id === "session") return sessionUsageModel(aggregateSessionUsage(localChatStore.trees));
        const node = localChatStore.trees.find((t) => t.id === s.id);
        return node ? turnUsageModel(node.attrs.usage) : null;
    };
    const title = (): string => {
        const s = props.state;
        if (!s) return "";
        if (s.id === "session") return "会话用量（累计）";
        const c = fmtTurnClock(s.id);
        return c ? `本轮用量 · ${c}` : "本轮用量";
    };

    return (
        <Show when={props.state && pos() && model()}>
            <Portal>
                <div
                    ref={(x: HTMLDivElement) => { el = x; }}
                    class="fixed z-[70] max-h-[calc(100vh-16px)] overflow-y-auto rounded-box border border-base-300 bg-base-100 shadow-2xl"
                    data-card={props.state!.id}
                    style={{ width: `${CARD_W}px` }}
                    onPointerEnter={props.onEnter}
                    onPointerLeave={props.onLeave}
                >
                    {/* viewbar：标题左、「明细」右 —— L2→L3 的唯一入口 */}
                    <div class="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-1.5">
                        <span class="text-body font-medium">{title()}</span>
                        <button
                            type="button"
                            class="btn btn-ghost btn-xs"
                            onClick={() => props.onDetail(props.state!.id)}
                        >
                            明细 ›
                        </button>
                    </div>
                    {/* 窗口占用大环（2026-10-03）：当前会话态，turn/session 卡同放；标注「当前」防误读成该轮 */}
                    <Show when={currentWindow(localChatStore.trees)}>
                        {(x) => (
                            <div class="flex items-center gap-3 border-b border-base-300 px-3 py-2">
                                <RingBar rate={x().rate} size="3rem" thickness="5px" center={pctText(x().rate)} />
                                <div class="text-body leading-tight">
                                    <div class="opacity-60">当前上下文（最后一步口径）</div>
                                    <div class="tabular-nums">
                                        {fmtTokens(x().total)} / {fmtTokens(x().contextLimit)}
                                    </div>
                                    <div class="opacity-60">
                                        距上限还有 {fmtTokens(Math.max(0, x().contextLimit - x().total))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </Show>
                    <Show when={model()} fallback={
                        <div class="px-3 py-2 text-body opacity-60">暂无用量记录（该会话还没跑出带用量的轮次）</div>
                    }>
                        {(m) => (
                            <div class="px-3 py-2" classList={{ "opacity-70": m().legacy }}>
                                <Show when={!m().legacy} fallback={<LegacyRows m={m()} />}>
                                    <UsageTableTree m={m()} />
                                </Show>
                            </div>
                        )}
                    </Show>
                </div>
            </Portal>
        </Show>
    );
}

// ─── L1① turn 底 bar ────────────────────────────────

/**
 * turn 底 bar：`HH:MM · N tok · $X` —— 只放时间、总 token 合计、金额（2026-10-03 定稿）。
 * 三数同为**各步累计**口径（可互算）；窗口% 不上 bar（不同口径不同框，防相除误读）。
 * hover 出 L2 卡；点击直接开 L3 抽屉（卡里的「明细」是同一动作的第二个入口）。
 */
export function TurnUsageBar(props: {
    turnId: string;
    usage: unknown;
    hover: boolean;
    onHover: (el: HTMLElement) => void;
    onHoverEnd: () => void;
    onDetail: () => void;
}) {
    /** 旧记录：无四桶无金额 → 降级成一行字，不进卡不进抽屉（拆不出东西） */
    if (isLegacyUsage(props.usage)) {
        const l = props.usage as { in?: number; out?: number; total?: number };
        return (
            <div class="text-body opacity-60">
                tokens ↑{fmtInt(l.in ?? 0)} ↓{fmtInt(l.out ?? 0)}（Σ{fmtInt(l.total ?? 0)}）
                <span class="ml-1">（旧记录：无四桶/金额）</span>
            </div>
        );
    }
    const p = () => props.usage as TurnUsagePatch;
    const clock = fmtTurnClock(props.turnId);
    return (
        <button
            type="button"
            class="flex w-max cursor-pointer select-none items-center gap-x-3 rounded px-1 text-body opacity-70 transition-opacity hover:bg-base-200 hover:opacity-100"
            aria-haspopup="dialog"
            aria-expanded={props.hover}
            aria-label="本轮用量（悬停看汇总，点击开逐步明细）"
            title="各轮/各步累计（重发成本口径，非窗口占用）。悬停看汇总，点击开逐步明细"
            onPointerEnter={(e) => props.onHover(e.currentTarget)}
            onPointerLeave={(e) => {
                // 元素被块树重建移除时浏览器也可能派发 leave —— 那不是"移出"，忽略
                if (!e.currentTarget.isConnected) return;
                props.onHoverEnd();
            }}
            onClick={props.onDetail}
        >
            <Show when={clock != null}>
                <span class="tabular-nums opacity-70">{clock}</span>
            </Show>
            <span class="tabular-nums">{fmtTokens(p().total)} tok</span>
            <span class="tabular-nums">{p().cost ? `$${fmtCost(p().cost!.total)}` : "$—"}</span>
        </button>
    );
}

// ─── L1② 发送区会话汇总 chip ────────────────────────

/** 发送区（人物按钮右侧）的会话累计：hover 出 L2 卡，点击开 L3 看板 */
export function SessionUsageChip(props: {
    hover: boolean;
    onHover: (el: HTMLElement) => void;
    onHoverEnd: () => void;
    onDetail: () => void;
}) {
    const agg = () => aggregateSessionUsage(localChatStore.trees);
    const label = () => {
        const a = agg();
        // 无数据也要显示 0（不是 "—"）—— 用户 2026-10-07：「显示 --tok.$-- 本身是错误的，应该显示 0 tok」
        if (a.turns === 0) return "0 tok · $0";
        return `${fmtTokens(a.total)} tok · ${a.cost ? `$${fmtCost(a.cost.total)}` : "$0"}`;
    };
    return (
        <button
            type="button"
            class="btn btn-ghost btn-xs tabular-nums"
            aria-haspopup="dialog"
            aria-expanded={props.hover}
            aria-label="会话累计用量（悬停看汇总，点击开看板）"
            title="会话累计（各轮各步之和，重发成本口径）。悬停看汇总，点击开用量看板"
            onPointerEnter={(e) => props.onHover(e.currentTarget)}
            onPointerLeave={(e) => {
                if (!e.currentTarget.isConnected) return;
                props.onHoverEnd();
            }}
            onClick={props.onDetail}
        >
            {label()}
        </button>
    );
}

// ─── L3 共用：MD/源码视图与导出文本 ─────────────────────

/**
 * viewbar 的 MD/源码切换（join 二选一，与 chat view「MD 原文/MD 渲染」同范式）。
 * 两键皆不亮 = 默认表格视图；再点已亮的键回到表格。
 */
function FmtToggle(props: { view: string; onView: (v: "md" | "raw") => void }) {
    return (
        <div class="join shrink-0" role="group" aria-label="明细展示格式">
            <button
                class={`btn btn-xs join-item ${props.view === "md" ? "btn-active" : "btn-ghost"}`}
                aria-pressed={props.view === "md"}
                aria-label="以 Markdown 源码查看"
                title="表格转成 Markdown 文本，方便复制"
                onClick={() => props.onView("md")}
            >
                MD
            </button>
            <button
                class={`btn btn-xs join-item ${props.view === "raw" ? "btn-active" : "btn-ghost"}`}
                aria-pressed={props.view === "raw"}
                aria-label="以原始记录查看"
                title="账本原始行（JSONL），方便复制/再处理"
                onClick={() => props.onView("raw")}
            >
                源码
            </button>
        </div>
    );
}

/** md/源码文本视图：右上「复制」+ 等宽 pre（纯文本态，直接可选中） */
function FmtBody(props: { text: () => string }) {
    const copy = () => {
        void navigator.clipboard.writeText(props.text());
        notificationStore.addToast("success", "已复制到剪贴板");
    };
    return (
        <div>
            <div class="mb-1 flex justify-end">
                <button type="button" class="btn btn-ghost btn-xs" onClick={copy}>
                    复制
                </button>
            </div>
            <pre class="whitespace-pre overflow-x-auto rounded-box border border-base-300 bg-base-200 p-3 font-mono text-caption leading-relaxed">{props.text()}</pre>
        </div>
    );
}

/** 金额格：主值 + 小字「占表内总$比例」（各项金额总占比，估花费变化用） */
const moneyCell = (v: number | null, total: number | null) =>
    v == null ? (
        <span class="opacity-50">n/a</span>
    ) : (
        <div class="leading-tight">
            <div>{fmtCost(v)}</div>
            <Show when={total != null && total > 0}>
                <div class="text-caption tabular-nums opacity-50" title="占表内总金额比例">{costShare(v, total)}</div>
            </Show>
        </div>
    );

/** L3 轮明细 → Markdown 源码（列与表格一致；% 同口径） */
function turnDetailMd(g: TurnGroup | null, rows: StepUsageRecord[], clock: string | null): string {
    const out: string[] = [`## 本轮逐步用量${clock ? ` · ${clock}` : ""}`, ""];
    if (g) {
        out.push(
            `- 窗口占用（最后一步）${pctText(g.last.windowRate)} · 步数 ${g.steps.length} · 缓存命中 ${pctText(cacheHitRate(g.buckets))} · 合计 $${fmtCost(g.cost?.total ?? 0)}`,
            "",
        );
    }
    const total$ = g?.cost?.total ?? null;
    const m = (n: number | null | undefined): string => (n == null ? "n/a" : `${fmtCost(n)}（${costShare(n, total$)}）`);
    out.push(
        "| 步 | 人物 | 模型 | 面 | 档位 | 非缓存输入 | 缓存读 | 缓存写 | 总输出 | 文本 | 思考 | 缓存命中 | 耗时 | TTFT | 窗口% | 单价快照 | 非缓存$ | 缓存读$ | 缓存写$ | 文本$ | 思考$ | 合计$ |",
        "|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const r of rows) {
        const v = stepView(r);
        const c = v.cost;
        const rates = r.rates
            ? `${r.rates.input}/${r.rates.output}/${r.rates.cacheRead ?? "–"}/${r.rates.cacheWrite ?? "–"} · ${r.rates.tier}`
            : "无价目";
        out.push(
            `| ${r.step} | ${r.persona ?? "—"} | ${r.model} | ${faceLabel(r.apiFace)} | ${r.reasoningEffort ?? "—"} ` +
                `| ${fmtInt(v.buckets.noCache)} | ${fmtInt(v.buckets.cacheRead)} | ${optCellInt(v.buckets.cacheWrite)} ` +
                `| ${fmtInt(v.buckets.outputTotal)} | ${fmtInt(v.buckets.text)} | ${fmtInt(v.buckets.reasoning)} ` +
                `| ${pctText(cacheHitRate(v.buckets))} | ${cellMs(r.performance?.stepTimeMs)} | ${cellMs(r.performance?.timeToFirstOutputMs)} ` +
                `| ${pctText(v.windowRate)} | ${rates} ` +
                `| ${c ? m(c.noCache) : "n/a"} | ${c ? m(c.cacheRead) : "n/a"} | ${c?.cacheWrite == null ? "n/a" : m(c.cacheWrite)} ` +
                `| ${c ? m(c.text) : "n/a"} | ${c ? m(c.reasoning) : "n/a"} | ${c ? m(c.total) : "n/a"} |`,
        );
    }
    return out.join("\n");
}

/** L3 会话看板 → Markdown 源码（按人物分行，列与表格一致） */
function sessionBoardMd(groups: AgentGroup[]): string {
    const costs = groups.filter((g) => g.cost != null).map((g) => g.cost!);
    const totalCost = costs.length ? sumCosts(costs) : null;
    const total$ = totalCost?.total ?? null;
    const m = (n: number | null | undefined): string => (n == null ? "n/a" : `${fmtCost(n)}（${costShare(n, total$)}）`);
    const steps = groups.reduce((s, g) => s + g.stepCount, 0);
    const buckets = sumBuckets(groups.map((g) => g.buckets));
    const out: string[] = ["## 会话用量（按人物）", ""];
    out.push(
        "| 人物 | 步 | 非缓存输入 | 缓存读 | 缓存写 | 总输入 | 总输出 | 文本 | 思考 | 缓存命中 | 非缓存$ | 缓存读$ | 缓存写$ | 文本$ | 思考$ | 合计$ |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const g of groups) {
        out.push(
            `| ${g.persona} | ${g.stepCount} | ${fmtInt(g.buckets.noCache)} | ${fmtInt(g.buckets.cacheRead)} | ${optCellInt(g.buckets.cacheWrite)} ` +
                `| ${fmtInt(g.buckets.inputTotal)} | ${fmtInt(g.buckets.outputTotal)} | ${fmtInt(g.buckets.text)} | ${fmtInt(g.buckets.reasoning)} ` +
                `| ${pctText(cacheHitRate(g.buckets))} ` +
                `| ${g.cost ? m(g.cost.noCache) : "n/a"} | ${g.cost ? m(g.cost.cacheRead) : "n/a"} | ${g.cost?.cacheWrite == null ? "n/a" : m(g.cost.cacheWrite)} ` +
                `| ${g.cost ? m(g.cost.text) : "n/a"} | ${g.cost ? m(g.cost.reasoning) : "n/a"} | ${g.cost ? m(g.cost.total) : "n/a"} |`,
        );
    }
    out.push(
        `| **合计** | **${steps}** | **${fmtInt(buckets.noCache)}** | **${fmtInt(buckets.cacheRead)}** | **${optCellInt(buckets.cacheWrite)}** ` +
            `| **${fmtInt(buckets.inputTotal)}** | **${fmtInt(buckets.outputTotal)}** | **${fmtInt(buckets.text)}** | **${fmtInt(buckets.reasoning)}** ` +
            `| **${pctText(cacheHitRate(buckets))}** ` +
            `| **${totalCost ? fmtCost(totalCost.noCache) : "n/a"}** | **${totalCost ? fmtCost(totalCost.cacheRead) : "n/a"}** ` +
            `| **${totalCost?.cacheWrite == null ? "n/a" : fmtCost(totalCost.cacheWrite)}** | **${totalCost ? fmtCost(totalCost.text) : "n/a"}** ` +
            `| **${totalCost ? fmtCost(totalCost.reasoning) : "n/a"}** | **${totalCost ? fmtCost(totalCost.total) : "n/a"}** |`,
    );
    return out.join("\n");
}

// ─── L3① 本轮逐步明细抽屉（旧两张表 → 一张双表头表） ───

/** 双表头明细表：第一行 = 大类（colspan 分组），第二行 = 列名。共 21 列 */
function TurnDetailTable(props: { rows: StepUsageRecord[] }) {
    /** 表内总$（各项金额占比的分母；与合计同口径：只算有价步） */
    const grand = (): number | null => {
        const costs = props.rows.map((r) => r.cost).filter((c): c is CostBreakdown => c != null);
        return costs.length ? sumCosts(costs).total : null;
    };
    return (
        <table class="table table-xs w-full whitespace-nowrap">
            <thead>
                <tr class="text-caption">
                    <th colspan="5" class="text-center font-medium opacity-60">身份</th>
                    <th colspan="7" class="text-center font-medium opacity-60">Token 桶</th>
                    <th colspan="3" class="text-center font-medium opacity-60">性能</th>
                    <th colspan="7" class="text-center font-medium opacity-60" title="各项金额下方小字 = 占本轮合计$比例">金额（$）· 占比</th>
                </tr>
                <tr>
                    <th>步</th>
                    <th>人物</th>
                    <th>模型</th>
                    <th>面</th>
                    <th>档位</th>
                    <th class="text-right">非缓存输入</th>
                    <th class="text-right">缓存读</th>
                    <th class="text-right">缓存写</th>
                    <th class="text-right" title="总输出 = 文本输出 + 思考输出">总输出</th>
                    <th class="text-right">文本</th>
                    <th class="text-right">思考</th>
                    <th class="text-right" title="缓存读 ÷ 总输入">缓存命中</th>
                    <th class="text-right">耗时</th>
                    <th class="text-right">TTFT</th>
                    <th class="text-right">窗口%</th>
                    <th title="该步生效单价（$/1M，入/出/读/写 · 生效档）">单价快照</th>
                    <th class="text-right">非缓存$</th>
                    <th class="text-right">缓存读$</th>
                    <th class="text-right">缓存写$</th>
                    <th class="text-right">文本$</th>
                    <th class="text-right">思考$</th>
                    <th class="text-right">合计$</th>
                </tr>
            </thead>
            <tbody>
                <For each={props.rows}>
                    {(r) => {
                        const v = () => stepView(r);
                        return (
                            <tr>
                                <td>{r.step}</td>
                                <td>{r.persona ?? "—"}</td>
                                <td>{r.model}</td>
                                <td>{faceLabel(r.apiFace)}</td>
                                <td>{r.reasoningEffort ?? "—"}</td>
                                <td class="text-right">{fmtInt(v().buckets.noCache)}</td>
                                <td class="text-right">{fmtInt(v().buckets.cacheRead)}</td>
                                <td class="text-right">{optCellInt(v().buckets.cacheWrite)}</td>
                                <td class="text-right">{fmtInt(v().buckets.outputTotal)}</td>
                                <td class="text-right">{fmtInt(v().buckets.text)}</td>
                                <td class="text-right">{fmtInt(v().buckets.reasoning)}</td>
                                <td class="text-right">{pctText(cacheHitRate(v().buckets))}</td>
                                <td class="text-right">{cellMs(r.performance?.stepTimeMs)}</td>
                                <td class="text-right">{cellMs(r.performance?.timeToFirstOutputMs)}</td>
                                <td class={`text-right ${pctClass(v().windowRate)}`}>{pctText(v().windowRate)}</td>
                                <td class="opacity-70">
                                    <Show when={r.rates} fallback={<span>无价目（该模型不在价格表内）</span>}>
                                        {(x) => (
                                            <span>
                                                {x().input}/{x().output}/{x().cacheRead ?? "–"}/{x().cacheWrite ?? "–"} · {x().tier}
                                            </span>
                                        )}
                                    </Show>
                                </td>
                                <td class="text-right">{moneyCell(v().cost?.noCache ?? null, grand())}</td>
                                <td class="text-right">{moneyCell(v().cost?.cacheRead ?? null, grand())}</td>
                                <td class="text-right">{moneyCell(v().cost?.cacheWrite ?? null, grand())}</td>
                                <td class="text-right">{moneyCell(v().cost?.text ?? null, grand())}</td>
                                <td class="text-right">{moneyCell(v().cost?.reasoning ?? null, grand())}</td>
                                <td class="text-right">{moneyCell(v().cost?.total ?? null, grand())}</td>
                            </tr>
                        );
                    }}
                </For>
            </tbody>
        </table>
    );
}

/** 抽屉顶部汇总条：窗口（最后一步口径）与累计数**分行标注**，不再并排裸奔 */
function TurnDetailSummary(props: { group: TurnGroup | null }) {
    const g = () => props.group;
    const hit = () => (g() ? cacheHitRate(g()!.buckets) : null);
    const rate = () => g()?.last.windowRate ?? null;
    const total = () => g()?.last.buckets.total ?? null;
    const limit = () => g()?.last.record.contextLimit ?? null;
    const inputT = () => g()?.last.buckets.inputTotal ?? null;
    const outputT = () => g()?.last.buckets.outputTotal ?? null;
    return (
        <Show when={g()}>
            {/* 与会话看板的窗口块同构（2026-10-03 对齐：progress 图 + 算式 + 距上限）；
                统计行（步数/命中/合计）随附在块内 —— 数字横排不给图是两页不一致的来源。 */}
            <div class="mb-3 rounded-box border border-base-300 p-3">
                <div class="mb-1 flex items-baseline justify-between">
                    <span class="text-body opacity-70">窗口占用（= 总输入 + 总输出，最后一步）</span>
                    <span
                        class={`text-prose font-medium ${pctClass(rate())}`}
                        title="该步 总输入+总输出 ÷ 模型上下文上限"
                    >
                        {pctText(rate())}
                    </span>
                </div>
                <progress
                    class={`progress w-full ${rate() != null && rate()! >= 0.9 ? "progress-error" : rate() != null && rate()! >= 0.75 ? "progress-warning" : "progress-success"}`}
                    value={Math.min(100, (rate() ?? 0) * 100)}
                    max="100"
                />
                <div class="mt-1 text-body opacity-60">
                    {total() != null
                        ? `${fmtInt(total()!)} / ${limit() != null ? fmtInt(limit()!) : "—"} tokens（= 总输入 ${fmtInt(inputT()!)} + 总输出 ${fmtInt(outputT()!)}）`
                        : "—"}
                    <Show when={limit() != null && total() != null}>
                        <span class="ml-1">· 距上限还有 {fmtInt(Math.max(0, limit()! - total()!))} tokens</span>
                    </Show>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-body">
                    <span>
                        <span class="opacity-60">步数</span> <span class="font-medium tabular-nums">{g()!.steps.length}</span>
                    </span>
                    <span>
                        <span class="opacity-60">缓存命中</span>{" "}
                        <span class="font-medium tabular-nums" title="缓存读 ÷ 总输入">
                            {hit() == null ? "—" : `${(hit()! * 100).toFixed(1)}%`}
                        </span>
                    </span>
                    <span>
                        <span class="opacity-60">合计</span>{" "}
                        <span class="font-medium tabular-nums">{g()!.cost ? `$${fmtCost(g()!.cost!.total)}` : "n/a"}</span>
                    </span>
                    <Show when={g()!.unpriced > 0}>
                        <span class="text-warning">{g()!.unpriced} 步无金额快照，合计为部分和</span>
                    </Show>
                </div>
            </div>
        </Show>
    );
}

/** L3：本轮逐步明细抽屉（覆盖页面；打开时对账一次账本，D1 修复语义迁到这里） */
export function TurnUsageDetailDrawer(props: { turnId: string | null; live: boolean; onClose: () => void }) {
    createEffect(() => {
        const u = localChatStore.currentUri;
        if (props.turnId && u) void localChatStore.refreshUsage(u);
    });
    const rows = () => (props.turnId ? localChatStore.usage.filter((r) => r.turnId === props.turnId) : []);
    const group = () => (props.turnId ? groupByTurn(localChatStore.usage).find((g) => g.turnId === props.turnId) ?? null : null);
    const clock = () => (props.turnId ? fmtTurnClock(props.turnId) : null);
    /** 表格 / MD 源码 / 账本源码（两键皆不亮 = 表格；再点已亮键回表格） */
    const [fmtView, setFmtView] = createSignal<"table" | "md" | "raw">("table");
    const toggleFmt = (v: "md" | "raw") => setFmtView((x) => (x === v ? "table" : v));
    const mdText = () => turnDetailMd(group(), rows(), clock());
    const rawText = () => rows().map((r) => JSON.stringify(r)).join("\n");

    const DM = useDrawerMax();
    return (
        <Show when={props.turnId}>
            {/* 形态（2026-10-03 定稿，与人物面板 PersonaDrawer 同构）：**全宽贴顶、高 2/3 屏** ——
                占满整个上半部分页面、下面只留 1/3 空位（用户点名，不再居中悬浮）。
                点遮罩 / ✕ / Escape 退出（Escape 在 LocalChatPage 的全局键处理里）。 */}
            <div class="fixed inset-0 z-50 flex flex-col" onClick={props.onClose}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl" style={DM.style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="truncate text-title font-medium">
                            本轮逐步用量
                            <Show when={clock()}>
                                <span class="ml-2 text-body font-normal opacity-60">{clock()}</span>
                            </Show>
                        </div>
                        <div class="ml-auto">
                            <FmtToggle view={fmtView()} onView={toggleFmt} />
                        </div>
                        <DrawerMaxButton max={DM.max()} onToggle={DM.toggle} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose} aria-label="关闭明细">
                            ✕
                        </button>
                    </div>
                    <div class="min-h-0 flex-1 overflow-auto p-4">
                    <Show when={fmtView() === "table"} fallback={<FmtBody text={() => (fmtView() === "md" ? mdText() : rawText())} />}>
                    <Show
                        when={rows().length > 0}
                        fallback={
                            /* 两种"还没有记录"必须分开说 —— 把正常态说成故障会让人白查一圈（D1）：
                               · 本轮还在跑：账本按步追加，此刻可能确实还没落到文件 → 正常，等一下；
                               · 本轮已停：确实没有记录（会话早于用量落盘上线，或写入失败）。 */
                            <div class="text-body opacity-50">
                                {props.live
                                    ? "本轮还在进行中，逐步账本按步写入，稍后即可见。"
                                    : "这一轮没有逐步记录（该会话早于用量落盘上线，或账本写入失败）。"}
                            </div>
                        }
                    >
                        <TurnDetailSummary group={group()} />
                        <div class="overflow-x-auto rounded-box border border-base-300 bg-base-100 p-2">
                            <TurnDetailTable rows={rows()} />
                        </div>
                        {/* 合计句式：等式写法是口径规范（禁止"输出 X · 思考 Y"并列句） */}
                        <div class="mt-2 text-caption opacity-60">
                            合计$ = 非缓存$ + 缓存读$ + 缓存写$ + 文本$ + 思考$；思考是总输出的拆解子项，
                            <span class="font-medium">不重复加</span>。缓存写 `n/a` = 该 API 面不可测（不是 0）。
                            单价按**每步**当时的生效档算（同一轮内 tier 也可能翻档），故逐行给快照。
                        </div>
                    </Show>
                    </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}

// ─── L3② 会话看板抽屉（旧两张表 → 一张双表头表） ───

/** 双表头会话表：身份(2) + Token 桶(8，含缓存命中) + 金额(6，带总占比) = 16 列，tfoot 带会话合计 */
function SessionUsageTable(props: { groups: AgentGroup[] }) {
    const totals = () => ({
        buckets: sumBuckets(props.groups.map((g) => g.buckets)),
        cost: (() => {
            const priced = props.groups.filter((g) => g.cost != null).map((g) => g.cost!);
            return priced.length ? sumCosts(priced) : null;
        })(),
        steps: props.groups.reduce((s, g) => s + g.stepCount, 0),
    });
    /** 表内总$（各项金额占比的分母） */
    const grand = (): number | null => totals().cost?.total ?? null;
    return (
        <table class="table table-xs w-full whitespace-nowrap">
            <thead>
                <tr class="text-caption">
                    <th colspan="2" class="text-center font-medium opacity-60">身份</th>
                    <th colspan="8" class="text-center font-medium opacity-60">Token 桶（累计）</th>
                    <th colspan="6" class="text-center font-medium opacity-60" title="各项金额下方小字 = 占会话总金额比例">金额（$）· 占比</th>
                </tr>
                <tr>
                    <th>人物</th>
                    <th class="text-right">步</th>
                    <th class="text-right">非缓存输入</th>
                    <th class="text-right">缓存读</th>
                    <th class="text-right">缓存写</th>
                    <th class="text-right">总输入</th>
                    <th class="text-right" title="总输出 = 文本输出 + 思考输出">总输出</th>
                    <th class="text-right">文本</th>
                    <th class="text-right">思考</th>
                    <th class="text-right" title="缓存读 ÷ 总输入">缓存命中</th>
                    <th class="text-right">非缓存$</th>
                    <th class="text-right">缓存读$</th>
                    <th class="text-right">缓存写$</th>
                    <th class="text-right">文本$</th>
                    <th class="text-right">思考$</th>
                    <th class="text-right">合计$</th>
                </tr>
            </thead>
            <tbody>
                <For each={props.groups}>
                    {(g) => (
                        <tr>
                            <td>{g.persona}</td>
                            <td class="text-right">{g.stepCount}</td>
                            <td class="text-right">{fmtInt(g.buckets.noCache)}</td>
                            <td class="text-right">{fmtInt(g.buckets.cacheRead)}</td>
                            <td class="text-right">{optCellInt(g.buckets.cacheWrite)}</td>
                            <td class="text-right">{fmtInt(g.buckets.inputTotal)}</td>
                            <td class="text-right">{fmtInt(g.buckets.outputTotal)}</td>
                            <td class="text-right">{fmtInt(g.buckets.text)}</td>
                            <td class="text-right">{fmtInt(g.buckets.reasoning)}</td>
                            <td class="text-right">{pctText(cacheHitRate(g.buckets))}</td>
                            <td class="text-right">{moneyCell(g.cost?.noCache ?? null, grand())}</td>
                            <td class="text-right">{moneyCell(g.cost?.cacheRead ?? null, grand())}</td>
                            <td class="text-right">{moneyCell(g.cost?.cacheWrite ?? null, grand())}</td>
                            <td class="text-right">{moneyCell(g.cost?.text ?? null, grand())}</td>
                            <td class="text-right">{moneyCell(g.cost?.reasoning ?? null, grand())}</td>
                            <td class="text-right">{moneyCell(g.cost?.total ?? null, grand())}</td>
                        </tr>
                    )}
                </For>
            </tbody>
            <tfoot>
                <tr class="font-medium">
                    <td colspan="2" class="opacity-70">会话合计（估算 · {totals().steps} 步）</td>
                    <td class="text-right">{fmtInt(totals().buckets.noCache)}</td>
                    <td class="text-right">{fmtInt(totals().buckets.cacheRead)}</td>
                    <td class="text-right">{optCellInt(totals().buckets.cacheWrite)}</td>
                    <td class="text-right">{fmtInt(totals().buckets.inputTotal)}</td>
                    <td class="text-right">{fmtInt(totals().buckets.outputTotal)}</td>
                    <td class="text-right">{fmtInt(totals().buckets.text)}</td>
                    <td class="text-right">{fmtInt(totals().buckets.reasoning)}</td>
                    <td class="text-right">{pctText(cacheHitRate(totals().buckets))}</td>
                    <td class="text-right">{totals().cost ? fmtCost(totals().cost!.noCache) : "n/a"}</td>
                    <td class="text-right">{totals().cost ? fmtCost(totals().cost!.cacheRead) : "n/a"}</td>
                    <td class="text-right">{totals().cost?.cacheWrite == null ? "n/a" : fmtCost(totals().cost!.cacheWrite!)}</td>
                    <td class="text-right">{totals().cost ? fmtCost(totals().cost!.text) : "n/a"}</td>
                    <td class="text-right">{totals().cost ? fmtCost(totals().cost!.reasoning) : "n/a"}</td>
                    <td class="text-right">{totals().cost ? `$${fmtCost(totals().cost!.total)}` : "n/a"}</td>
                </tr>
            </tfoot>
        </table>
    );
}

/**
 * 会话用量看板（L3 抽屉）。
 *
 * 内容顺序照用户的决策链：**先看窗口占用**（决定要不要重置）→ 再看花了多少（决定值不值）
 * → 最后看单价依据（为什么是这个数）。行键 = **人物**（模型/面/档位是步级属性、可能步间变化，
 * 不进分组键 —— 见 shared/usage.ts keyOfGroup；步级身份看轮明细表），与 CLI 的 `--by-agent` 同源同口径。
 */
export function UsageDrawer(props: { open: boolean; uri: string | null; onClose: () => void }) {
    // 每次打开顺手对一次账本：轮次间隙里**别人**（CLI / 另一窗口）跑的轮次，
    // 我这侧的下降沿重放会补，但打开看板这个动作本身就说明"我要看最新的数"，不该给旧值。
    createEffect(() => {
        if (props.open && props.uri) void localChatStore.refreshUsage(props.uri);
    });
    const steps = () => localChatStore.usage;
    /** 窗口占用取**最后一步**：上下文压力是当前状态，不是历史累加（##211 §三） */
    const last = () => {
        const list = steps();
        return list.length ? stepView(list[list.length - 1]!) : null;
    };
    const rate = () => (last() ? windowRate(last()!.buckets, last()!.record.contextLimit) : null);
    const tiers = () => [...new Set(steps().map((r) => r.rates?.tier).filter((t): t is string => !!t))];
    /** 表格 / MD 源码 / 账本源码（两键皆不亮 = 表格；再点已亮键回表格） */
    const [fmtView, setFmtView] = createSignal<"table" | "md" | "raw">("table");
    const toggleFmt = (v: "md" | "raw") => setFmtView((x) => (x === v ? "table" : v));
    const mdText = () => sessionBoardMd(groupByAgent(steps()));
    const rawText = () => steps().map((r) => JSON.stringify(r)).join("\n");

    const DM = useDrawerMax();
    return (
        <Show when={props.open}>
            {/* 与 TurnUsageDetailDrawer 同款形态（与 PersonaDrawer 同构）：全宽贴顶、高 2/3 屏，
                下方留 1/3 空位；点遮罩 / ✕ / Escape 退出（2026-10-03 定稿） */}
            <div class="fixed inset-0 z-50 flex flex-col" onClick={props.onClose}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl" style={DM.style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="text-title font-medium">会话用量</div>
                        <div class="ml-auto">
                            <FmtToggle view={fmtView()} onView={toggleFmt} />
                        </div>
                        <DrawerMaxButton max={DM.max()} onToggle={DM.toggle} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose} aria-label="关闭看板">
                            ✕
                        </button>
                    </div>
                    <div class="min-h-0 flex-1 overflow-auto p-4">
                    <Show when={fmtView() === "table"} fallback={<FmtBody text={() => (fmtView() === "md" ? mdText() : rawText())} />}>
                    <Show
                        when={steps().length > 0}
                        fallback={
                            <div class="text-body opacity-60">
                                还没有用量记录。跑一轮本地 agent 后，每步会写入用量账本（详见应用日志）。
                            </div>
                        }
                    >
                        {/* 窗口占用：用户点名的「最重要的一个数」——距上限多远、何时该重置 */}
                        <div class="mb-3 rounded-box border border-base-300 p-3">
                            <div class="mb-1 flex items-baseline justify-between">
                                <span class="text-body opacity-70">窗口占用（= 总输入 + 总输出，取最近一步）</span>
                                <span class={`text-prose font-medium ${pctClass(rate())}`}>{pctText(rate())}</span>
                            </div>
                            <progress
                                class={`progress w-full ${rate() != null && rate()! >= 0.9 ? "progress-error" : rate() != null && rate()! >= 0.75 ? "progress-warning" : "progress-success"}`}
                                value={Math.min(100, (rate() ?? 0) * 100)}
                                max="100"
                            />
                            <div class="mt-1 text-body opacity-60">
                                {last()
                                    ? `${fmtInt(last()!.buckets.total)} / ${last()!.record.contextLimit ? fmtInt(last()!.record.contextLimit!) : "—"} tokens（= 总输入 ${fmtInt(last()!.buckets.inputTotal)} + 总输出 ${fmtInt(last()!.buckets.outputTotal)}）`
                                    : "—"}
                                <Show when={last()?.record.contextLimit}>
                                    {(lim) => (
                                        <span class="ml-1">
                                            · 距上限还有 {fmtInt(Math.max(0, lim() - (last()?.buckets.total ?? 0)))} tokens
                                        </span>
                                    )}
                                </Show>
                            </div>
                        </div>

                        {/* 按人物分行（模型/面/档位是步级属性，不进分组键）；token 与金额一张表（双表头），tfoot 带合计 */}
                        <div class="mb-2 text-body opacity-70">按人物分行（模型/面/档位会随步变化，步级身份看轮明细）</div>
                        <div class="overflow-x-auto">
                            <SessionUsageTable groups={groupByAgent(steps())} />
                        </div>

                        <div class="mt-2 text-caption opacity-60">
                            单价依据 models.dev
                            {steps().find((r) => r.rates?.asOf)?.rates?.asOf
                                ? `@${steps().find((r) => r.rates?.asOf)!.rates!.asOf}`
                                : ""}
                            {" · "}
                            生效档位：{tiers().length ? tiers().join(", ") : "—"}
                            （tier 按总输入 token 选，取满足条件的最大阈值）
                            <br />
                            `合计$` = 非缓存 + 缓存读 + 缓存写 + 文本 + 思考；思考是总输出的拆解子项，
                            <span class="font-medium">不重复加</span>。缓存写 `n/a` = 该 API 面不可测（不是 0）。
                        </div>
                    </Show>
                    </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}

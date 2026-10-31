/**
 * UsagePanel — 用量可见性的**三级收纳**（契约见任务 211 §六b；交互形态 2026-10-03 与用户对齐）：
 *
 *   L1 实时常显（页面只留一行数，大表一律藏进 L3）：
 *     · TurnUsageBar     —— turn 尾一行：`时刻（左，纯文本） … N tok · $X（右，按钮）`（时刻与用量分开，见其头注）；
 *       直播中第一步还没跑完时先出**占位**（`pending`：时间照给、用量位写"⋯ 统计中"）
 *     · SessionUsageChip —— 发送区人物右侧：会话累计 `N tok · $X`
 *   L2 hover 汇总卡：纵向 8 项（token 桶加总 + 输入$/输出$/合计$），
 *     卡顶 viewbar 右侧「明细」→ L3
 *   L3 drawer（覆盖页面，##443 刀 3 起）：**一张表**（`UsageTable`）+ 一个 group 选项
 *     （step / turn / persona / session / 窗口构成）；下钻是同一张表换参数，不再有"本轮专用表"。
 *     列定义与聚合都在 `shared/usage-fields.ts`，这里只剩容器与状态。
 *
 * 数字来源两条，**不许混**：
 *   · L1/L2 = turn 块属性（main 每步 patch，实时；会话数 = 各轮 attrs 累加，同为累计口径）
 *   · L3    = `<key>.usage.jsonl` 镜像（localChatStore.usage；开抽屉时对账刷新）
 *
 * 口径硬约束（##211 §一/§四，违者即口径事故）：
 *   · 总输入 = 非缓存 + 缓存读 + 缓存写；总输出 = 文本输出 + 思考输出（思考不另加价）
 *     （##354 ①：桶名一律**不带「输入」后缀** —— 有的带有的不带就成了不成对的一组，
 *      且组行已叫「总输入」；「非缓存 / 缓存读 / 缓存写」才是平行的一组）
 *   · L1/L2 只放**累计口径**（各步累加，解释"花了多少"）；窗口% 是**最后一步**口径，只进 L3
 *     —— 两个口径不同框并排，是 ##231 相除误读（"986k 才 4%?"）的直接教训
 *   · 不可测桶写 `–`/`n/a`，**不写 0**；旧记录（无四桶字段）按原样降级，不假装能拆
 */

import { createEffect, createResource, createSignal, For, Match, Show, Switch, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { localChatStore } from "../store/localChatStore";
// 时间口径唯一出处（shared/date-format）：面板里的轮次时刻（hover 卡标题 / 明细抽屉）与对话流
// 首行同格式（fmtTurnStamp）；表格的「时间」列走 `usage-fields` 的 fmtCell（到秒）。
import { fmtTurnStamp } from "../../shared/date-format";
import { DrawerMaxButton, RowGutter, useDrawerMax } from "@diy-agent/ui-kit";
import { endMarkOf } from "../lib/chat-fold";
import {
    cacheHitRate,
    fmtCost,
    fmtInt,
    fmtTokens,
    groupByTurn,
    recordsAvgRate,
    stepView,
    sumCosts,
    stepRate,
    windowRate,
    type CostBreakdown,
    type TurnGroup,
    type TurnUsagePatch,
} from "../../shared/usage";
import type { BlockNode, TurnEndReason } from "../../main/services/local-blocks";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { notificationStore } from "../store/notificationStore";
import { copyFailMeta, copyOkMeta } from "../lib/notice-copy";
import { compactNotice } from "../lib/notice-compact";
import { useCompactPanel, CompactPanelContent } from "./CompactSessionPanel";
import { UsageTable, usageTableMd, type UsageView } from "./UsageTable";
import type { CompactEventRecord } from "@diy-agent/compaction/compaction";
import { type DeliveryBoundary } from "../../shared/context/delivery-badge";
// 缓存时效柱（##477 追加）：对数刻度 / 三区判据都在 shared（纯函数、可单测）
import {
    CACHE_AGE_DOMAIN_MAX_MS,
    CACHE_AGE_DOMAIN_MIN_MS,
    CACHE_AGE_TICKS_MS,
    cacheAgeZone,
    effectiveFailLine,
    formatGap,
    logScalePos,
    type CacheChannelView,
} from "../../shared/cache-hint";
import { diyService } from "../lib/rpc";

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
/**
 * 旧版 ops.jsonl 里的 usage 属性只有 {in,out,cached,total}（无四桶字段）。
 * 历史日志是 append-only 的史书，读侧必须兼容 —— 不当成"没有用量"，也不假装它是新格式。
 */
function isLegacyUsage(u: unknown): boolean {
    const r = u as Record<string, unknown> | null;
    return !!r && typeof r["noCache"] !== "number";
}

/**
 * turnId → 本轮**开始时刻**（epoch ms）。旧格式 id / 脏值 → null。
 * 轮尾状态行的时刻与「当前 token 速度」的分母都取自这里 —— **一处解析**，
 * 免得两处各写一份正则、各自对"什么算合法 id"有不同看法。
 */
export function turnStartMs(turnId: string): number | null {
    const m = /^t(\d{13})$/.exec(turnId);
    if (!m) return null;
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? ms : null;
}

/** turnId（`t` + 13 位 epoch ms）→ `YYYY-MM-DD HH:MM:SS`；旧格式 id 解析不出就不显示（不编时间） */
function fmtTurnClock(turnId: string): string | null {
    const start = turnStartMs(turnId);
    if (start == null) return null;
    const d = new Date(start);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, "0");
    // 日期 + 时间到秒（用户 2026-10-04：轮次末尾要能定位"什么时候说的"）
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 该轮**实时档**速度（tok/s，⚡）= **最后一步**的实测生成速度：两处来源，口径同一个
 * （`shared/usage.stepRate`，**含首字等待**）。
 *
 *   ① `usage.lastStepRate` —— main 在每步 finish-step 下发的 patch 字段：**直播时最新**；
 *   ② 逐步账本镜像（`localChatStore.usage` = `usage.jsonl` 的镜像，打开会话 / 轮次结束时对账刷新）：
 *      **本版之前**落的 ops 没有 ①（那时还没这字段），但账本里本来就有 `performance` —— 用它补齐，
 *      省得"老会话永远看不到速度"。镜像里没有这一轮（直播刚起步、一步都还没跑完）→ null。
 */
function turnStepRate(turnId: string, usage: unknown): number | null {
    const fromPatch = (usage as TurnUsagePatch | undefined)?.lastStepRate;
    if (typeof fromPatch === "number" && fromPatch > 0) return fromPatch;
    const mine = localChatStore.usage.filter((r) => r.turnId === turnId);
    const last = mine[mine.length - 1];
    return last ? stepRate(last.performance, stepView(last).buckets.outputTotal) : null;
}

/**
 * 该轮**轮均档**速度（tok/s，⌀）= 本轮 Σ总输出 ÷ Σ各步响应耗时（含首字等待，`shared/usage.avgRate`）。
 *
 * 优先用 main 每步下发的 `usage.turnRate`（**直播中也在长**，不是轮末才算一次）；
 * 本版之前的 ops 没有该字段 → 由逐步账本镜像现算（账本里本来就有各步 `performance`）。
 * 镜像里没有这一轮（直播刚起步、一步都还没跑完）→ null。
 */
function turnAvgRate(turnId: string, usage: unknown): number | null {
    const fromPatch = (usage as TurnUsagePatch | undefined)?.turnRate;
    if (typeof fromPatch === "number" && fromPatch > 0) return fromPatch;
    const mine = localChatStore.usage.filter((r) => r.turnId === turnId);
    return mine.length ? recordsAvgRate(mine) : null;
}

/**
 * 整个会话**总均档**速度（tok/s，⌀）= 全部步 Σ总输出 ÷ Σ各步响应耗时（含首字等待）。
 *
 * 数据源 = 逐步账本镜像（`localChatStore.usage`；**直播中按步刷新**）。
 * 与轮尾那枚不重复：轮尾是"本轮"，这里是"全局"（用户 2026-10-15 口径）。
 */
export function sessionAvgRate(): number | null {
    return recordsAvgRate(localChatStore.usage);
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
    /** **无价目**的轮数（##372）：>0 时上面的 cost 是部分和，UI 要标注（「—」而不是 $0） */
    unpriced: number;
}

export function aggregateSessionUsage(trees: BlockNode[]): SessionUsageAgg {
    const a: SessionUsageAgg = {
        turns: 0, legacyTurns: 0, noCache: 0, cacheRead: 0, cacheWrite: null,
        inputTotal: 0, text: 0, reasoning: 0, outputTotal: 0, total: 0, cost: null,
        unpriced: 0,
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
        else a.unpriced++;
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
                    "├ 非缓存", m().noCache, "未命中前缀缓存、按全价计（本轮各步累计）",
                    c()?.noCache ?? null, "非缓存金额",
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
 * 会话**当前模型**（取 id 最新、带 model 的 turn）—— 缓存时效柱按它解析渠道（provider × model）。
 * 与 {@link currentWindow} 同一个"最新"判据：同一个会话里两个读数不该指着不同的轮。
 */
function currentModelRef(trees: BlockNode[]): string | null {
    let best: string | null = null;
    let bestId = -1;
    for (const t of trees) {
        if (t.tag !== "turn") continue;
        const m = t.attrs.model;
        if (typeof m !== "string" || m === "") continue;
        const n = Number(String(t.id).replace(/^t/, ""));
        if (!Number.isFinite(n) || n < bestId) continue;
        bestId = n;
        best = m;
    }
    return best;
}

/**
 * 缓存时效柱（##477 追加需求）—— 与「窗口占用环」是**两个维度**（token vs 时间），环不动、柱另起一块。
 *
 *   缓存时效
 *   ├────●─────────▲──────────────┃──────────┤
 *   1min 5min     10min          42min       24h
 *        安全点     失效点          现在
 *
 * 三条设计要求（用户 10-30）：
 *   ① **对数刻度**：1min → 24h 跨度太大，线性的话 5min 与 10min 会挤成一点
 *   ② 区域着色：安全点左 = 安全（绿）· 两标记之间 = 警告（黄）· 失效点右 = 危险（红）
 *   ③ 当前时刻的点要醒目，落在危险区时整条柱变红（与顶栏那行提示联动）
 * failPoint = +∞（从没失败过）时只画安全点与当前点，右半段**不标红** —— 没证据就不吓人。
 */
function CacheAgeBar(props: { model: string | null }) {
    const [view, setView] = createSignal<CacheChannelView | null>(null);
    const [now, setNow] = createSignal(Date.now());

    // 数据 = main 侧 store（重启后仍是上次的边界）；卡一开就取一次，卡卸载后丢弃旧响应
    createEffect(() => {
        const m = props.model;
        if (!m) {
            setView(null);
            return;
        }
        let alive = true;
        void diyService.diy.cacheHint
            .stats({ model: m })
            .then((v) => {
                if (alive) setView(v);
            })
            .catch(() => {
                if (alive) setView(null);
            });
        onCleanup(() => {
            alive = false;
        });
    });

    // 「现在」每秒重算：停在这里看，间隔本来就该继续长大（冻结在渲染那一刻等于说谎）
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));

    const gap = (): number | null => {
        const v = view();
        return v && v.lastRequestAt !== null ? Math.max(0, now() - v.lastRequestAt) : null;
    };
    const pos = (ms: number): string => `${(logScalePos(ms) * 100).toFixed(2)}%`;
    /** 柱上生效的失效线：安全点更高时两条线重合在安全点（否则警告段宽度会变负） */
    const failAt = (): number | null => {
        const v = view();
        return v ? effectiveFailLine(v.safePointMs, v.failPointMs) : null;
    };
    const zone = (): "safe" | "warn" | "danger" | null => {
        const v = view();
        const g = gap();
        return v && g !== null ? cacheAgeZone(g, v.safePointMs, v.failPointMs) : null;
    };
    const zoneText = (): string =>
        zone() === "danger" ? "危险区" : zone() === "warn" ? "警告区" : zone() === "safe" ? "安全区" : "—";
    const tone = (): string =>
        zone() === "danger" ? "text-error" : zone() === "warn" ? "text-warning" : "text-success";

    return (
        <Show when={view()}>
            {(v) => (
                <div class="border-b border-base-300 px-3 py-2" data-cache-age-bar data-cache-age-zone={zone() ?? ""}>
                    <div class="mb-1 flex items-baseline justify-between gap-2">
                        <span class="text-body opacity-70">缓存时效（距上次请求 · 对数刻度）</span>
                        <span class={`text-body font-medium tabular-nums ${tone()}`}>
                            {gap() === null ? "—" : `${formatGap(gap()!)} · ${zoneText()}`}
                        </span>
                    </div>
                    <div
                        class="relative h-2 w-full rounded-full bg-base-300"
                        classList={{ "ring-1 ring-error": zone() === "danger" }}
                        role="img"
                        aria-label={`缓存时效：安全点 ${formatGap(v().safePointMs)}，${
                            v().failPointMs === null ? "失效点未记录" : `失效点 ${formatGap(v().failPointMs!)}`
                        }，当前 ${gap() === null ? "未知" : formatGap(gap()!)}`}
                    >
                        {/* 安全区（绿）：0 → 安全点 */}
                        <span
                            class="absolute inset-y-0 left-0 rounded-l-full bg-success/40"
                            style={{ width: pos(v().safePointMs) }}
                        />
                        {/* 警告区（黄）：安全点 → 失效点 / 右边（failPoint = +∞） */}
                        <span
                            class="absolute inset-y-0 bg-warning/40"
                            style={{
                                left: pos(v().safePointMs),
                                width:
                                    failAt() === null
                                        ? `calc(100% - ${pos(v().safePointMs)})`
                                        : `${((logScalePos(failAt()!) - logScalePos(v().safePointMs)) * 100).toFixed(2)}%`,
                            }}
                        />
                        {/* 危险区（红）：失效点 → 右边；+∞ 时整段不画 */}
                        <Show when={failAt() !== null}>
                            <span
                                class="absolute inset-y-0 rounded-r-full bg-error/40"
                                style={{
                                    left: pos(failAt()!),
                                    width: `calc(100% - ${pos(failAt()!)})`,
                                }}
                            />
                        </Show>
                        {/* 安全点（▲） */}
                        <span
                            class="absolute -top-0.5 h-3 w-0.5 bg-success"
                            style={{ left: pos(v().safePointMs) }}
                            title={`安全点 ${formatGap(v().safePointMs)}（成功样本的 P90）`}
                        />
                        {/* 失效点（▲） */}
                        <Show when={failAt() !== null}>
                            <span
                                class="absolute -top-0.5 h-3 w-0.5 bg-error"
                                style={{ left: pos(failAt()!) }}
                                title={`失效点 ${formatGap(v().failPointMs!)}（首步几乎全未命中过的间隔）`}
                            />
                        </Show>
                        {/* 当前时刻（●）：落点醒目；危险区时整条柱已变红 */}
                        <Show when={gap() !== null}>
                            <span
                                class={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-base-100 ${
                                    zone() === "danger" ? "bg-error" : zone() === "warn" ? "bg-warning" : "bg-success"
                                }`}
                                style={{ left: pos(gap()!) }}
                                title={`现在：距上次请求 ${formatGap(gap()!)}`}
                            />
                        </Show>
                    </div>
                    {/* 刻度：1min / 5min / 1h / 24h（对数位置） */}
                    <div class="relative mt-0.5 h-4 text-caption opacity-60">
                        <span class="absolute left-0">1min</span>
                        <For each={CACHE_AGE_TICKS_MS}>
                            {(ms) => (
                                <Show when={ms > CACHE_AGE_DOMAIN_MIN_MS && ms < CACHE_AGE_DOMAIN_MAX_MS}>
                                    <span class="absolute -translate-x-1/2" style={{ left: pos(ms) }}>
                                        {formatGap(ms)}
                                    </span>
                                </Show>
                            )}
                        </For>
                        <span class="absolute right-0">24h</span>
                    </div>
                    <div class="text-caption opacity-70">
                        <span class="text-success">▲ 安全点 {formatGap(v().safePointMs)}</span>
                        <Show
                            when={v().failPointMs !== null}
                            fallback={<span class="ml-2">失效点：未记录（从没失败过 → 右半段不标红）</span>}
                        >
                            <span class="ml-2 text-error">
                                ▲ 失效点 {formatGap(v().failPointMs!)}
                                <Show when={v().failPointMs! < v().safePointMs}>
                                    （安全点更高，按 {formatGap(v().safePointMs)} 算）
                                </Show>
                            </span>
                        </Show>
                        <Show when={v().samples === 0}>
                            <span class="ml-2">· 暂无历史（安全点 = 60s 保护值）</span>
                        </Show>
                    </div>
                </div>
            )}
        </Show>
    );
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
 *
 * ⚠️ **弧长必须与百分比文字同源、同刻**（##354 ②）。`--value` 的字符串**只能在 JSX 里现算**
 * （`style={ringStyle(...)}`），不能像 load 一次那样提到组件体里算：
 * Solid 的组件体**只执行一次**，提到体外的那串值会被**冻在挂载那一刻**，此后 rate 怎么变都不再
 * 参与绑定 —— 而旁边的百分比文字是响应式插值。症状：文字 9%、弧长还停在挂载时的 60%
 * （切会话时 `trees` 还是上一个会话的 → 挂载帧算出的就是旧值）。判据：弧长与文字**恒等**
 * （同一次渲染里同一个 `props.rate`），不得引入任何中间基准/梯度缩放。
 */
function RingBar(props: { rate: number; size: string; thickness: string; center?: string; label?: string }) {
    /** 环的样式串（在 JSX 里调用 → 读到的是**本次**的 props.rate，故随信号更新） */
    const ringStyle = (value: number | string) =>
        `--value:${value};--size:${props.size};--thickness:${props.thickness}`;
    return (
        <div
            class="relative shrink-0"
            style={{ width: props.size, height: props.size }}
            role="progressbar"
            aria-label={props.label ?? "窗口占用"}
            aria-valuenow={Math.round(props.rate * 100)}
        >
            <div class="radial-progress absolute left-0 top-0 text-base-300" style={ringStyle(100)} />
            <div
                class={`radial-progress absolute left-0 top-0 ${ringClass(props.rate)}`}
                style={ringStyle(ringValue(props.rate))}
            />
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

/**
 * L1 窗口占用环：发送区会话 chip 右侧（token/金额总量右边）。
 * · 环 = RingBar（底轨 + 五档色）；% 与环同侧。
 * · hover 弹构成卡（三段估算 + 总量精确）；卡上「明细 →」打开构成报表（总/分两表）。
 * 数据链：turn patch 的 contextParts（main 每步真发时记字节）+ 账本 prompt —— 不做 hover 现算。
 */
export function WindowRing(props: { uri: string | null }) {
    // ⚠️ 一律用**本页的 uri**（props.uri），不用 `localChatStore.currentUri`：后者在组件挂载那一刻
    //    还指着**上一个会话**，于是"切到别的会话"会拿旧 uri 白算一遍（##321 现象二）。
    const w = () => currentWindow(localChatStore.trees);
    /** 无数据也显示环（0%）—— 用户 2026-10-07：「无数据时应显示 0%」，不是整块消失 */
    const win = () => w() ?? { total: 0, contextLimit: 0, rate: 0, prompt: null, parts: null };
    const [open, setOpen] = createSignal(false);
    const [drawerOpen, setDrawerOpen] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    /** 直接压缩一次（用当前配置的预算）—— 用户 2026-10-07「点后直接压缩，不要弹到详情页」 */
    const apply = async () => {
        const u = props.uri;
        if (!u) return;
        setBusy(true);
        try {
            const rec = await localChatStore.compact(u, { limitTokens: limitTok() } as never);
            if (rec?.noop) {
                notificationStore.addToast(
                    "info",
                    "内容不足一步，无法压缩",
                    compactNotice({
                        kind: "noop",
                        limitTokens: limitTok(),
                        uri: u,
                    }),
                );
            } else {
                notificationStore.addToast(
                    "success",
                    "已压缩（历史保留、可撤销）",
                    compactNotice({ kind: "done", limitTokens: limitTok(), uri: u }),
                );
            }
            setOpen(false);
        } catch (e) {
            notificationStore.addToast(
                "error",
                String(e instanceof Error ? e.message : e),
                compactNotice({ kind: "failed", limitTokens: limitTok(), uri: u, error: e }),
            );
        } finally {
            setBusy(false);
        }
    };
    const [anchor, setAnchor] = createSignal<{ left: number; top: number } | null>(null);
    let closeT: ReturnType<typeof setTimeout> | undefined;

    /** 保留量（token）—— ##442 固定 = 窗口 × 0.16；窗口未知 ⇒ 0 */
    // 门槛 = 卡或抽屉真的开着：本组件常挂（会话页脚常驻），无门槛则**每次切会话页**都白打一次
    // `autoCompactStatus`（##321 复核补记的次级成本；非主因，但同属"抽屉关着也算"）。
    const [limitRes] = createResource(() => (open() || drawerOpen() ? props.uri : null), async (u) => {
        if (!u) return null;
        const st = (await localChatStore.autoCompactStatus(u)) as {
            facts?: { windowLimitTokens?: number | null };
        };
        const w = st?.facts?.windowLimitTokens;
        return typeof w === "number" && w > 0 ? Math.floor(w * 0.16) : 0;
    });
    const limitTok = (): number => limitRes() ?? 0;
    /** 压缩后估算 token：固定开支（system+工具）+ 保留量（窗口 × 0.16） */
    const afterTokens = (): number | null => {
        const p = partsOf(win());
        const fixed = (p.system ?? 0) + (p.tools ?? 0);
        return fixed + Math.round(limitTok());
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
            <ContextPartsDrawer open={drawerOpen()} uri={props.uri} onClose={() => setDrawerOpen(false)} />
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
export function ContextPartsDrawer(props: { open: boolean; uri: string | null; onClose: () => void }) {
    /** 第一 tab = 压缩（##246 用户定的顺序；UI 用例也按这个顺序断言） */
    const [view, setView] = createSignal<"compact" | "parts">("compact");
    // 打开对账一次账本 + Escape 自管（stopPropagation：别把别的抽屉连带关了）
    createEffect(() => {
        if (!props.open) return;
        const u = props.uri;
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
    /** 压缩面板控制器（供 tab 栏执行按钮 + 压缩 tab 内容共享）。
     *  第二个参数 = **成本闸门**：抽屉关着时组件仍挂在树上，不加门槛则任何会话页一打开
     *  就全量算一次压缩预案（78MB 会话 8~16s 卡住 main，见 ##321）。 */
    const ctl = useCompactPanel(() => props.uri ?? "", () => props.open);

    // 压缩事件账（步视图的「压缩点位」列 + 徽章 hover 的边界）——限读尾部（##431）
    const [compactPage, { refetch: refetchCompactEvents }] = createResource(
        () => (props.open ? props.uri : null),
        async (u) =>
            u
                ? ((await localChatStore.compactEvents(u)) as { events: CompactEventRecord[]; truncated: boolean })
                : { events: [] as CompactEventRecord[], truncated: false },
    );
    const compactEvents = () => compactPage()?.events ?? [];
    const compactList = () => compactEvents();
    const latestTurnId = () => steps().at(-1)?.turnId;
    const turnCompactCount = (turnId: string) => {
        const first = steps().find((r) => r.turnId === turnId)?.ts ?? "";
        return compactList().filter((e) => e.kind === "compact" && String(e.ts) >= first).length;
    };
    const [autoStatus] = createResource(
        () => (props.open ? props.uri : null),
        async (u) =>
            u
                ? ((await localChatStore.autoCompactStatus(u)) as unknown as {
                      /** ##432 事件制：已落盘的压缩边界（null = 从没压过） */
                      facts?: { boundary?: { at: string; dropped: number; limitTokens: number } | null };
                  })
                : undefined,
    );
    /**
     * 已落盘的压缩边界 —— `undefined` = 还没取到（不写这块），`null` = 确实没压过（投递 = 全量）。
     * 两个值不能合成一个：没取到就说「没压过」等于编事实。
     */
    const badgeBoundary = (): DeliveryBoundary | null | undefined => {
        const st = autoStatus();
        if (!st) return undefined;
        return st.facts?.boundary ?? null;
    };

    const DM = useDrawerMax();
    return (
        <Show when={props.open}>
            {/* 与用量抽屉同构：全宽贴顶、高 2/3 屏；点遮罩 / ✕ / Escape 退出 */}
            <div class="fixed inset-0 z-50 flex flex-col" data-find-surface onClick={props.onClose}>
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
                                data-drawer-tab="compact"
                                onClick={() => setView("compact")}
                            >
                                压缩
                            </button>
                            <button
                                class={`btn btn-xs join-item ${view() === "parts" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={view() === "parts"}
                                data-drawer-tab="parts"
                                onClick={() => setView("parts")}
                            >
                                构成
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
                        {/* ##423 ③：会话/本轮的两个数（压缩次数 / 投递次数）此前哪里都看不到 */}
                        <Show when={steps().length > 0}>
                            <div
                                class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption opacity-80"
                                data-delivery-stats
                            >
                                <span>
                                    本会话：<b class="tabular-nums">{steps().length}</b> 次投递（= 步数）·
                                    <b class="tabular-nums">{new Set(steps().map((r) => r.turnId)).size}</b> 轮 · 压缩{" "}
                                    <b class="tabular-nums">{compactList().filter((e) => e.kind === "compact").length}</b> 次
                                    （自动 {compactList().filter((e) => e.kind === "compact" && e.by === "auto").length} / 手动{" "}
                                    {compactList().filter((e) => e.kind === "compact" && e.by !== "auto").length}）
                                </span>
                                <Show when={latestTurnId()}>
                                    {(id) => (
                                        <span title="本轮步数 = 本轮投递次数；压缩 = 本轮生效（下一个轮首请求用上新历史）的压缩事件数">
                                            本轮 {id()}：<b class="tabular-nums">{steps().filter((r) => r.turnId === id()).length}</b> 步 · 压缩生效{" "}
                                            <b class="tabular-nums">{turnCompactCount(id())}</b> 次
                                        </span>
                                    )}
                                </Show>
                            </div>
                        </Show>

                        {/* 构成 = 统一表的一个视图（group=窗口构成）：与逐步同列定义，只是列子集 + 仅 step 粒度 */}
                        <UsageTable
                            rows={steps()}
                            view="contextParts"
                            compactEvents={compactEvents()}
                            boundary={badgeBoundary()}
                        />

                        <div class="mt-2 text-caption opacity-60">
                            ~ = 字节 ÷ 4 估算（中英混排会偏差）；历史消息 = 同行 prompt（账本精确）− 系统 − 工具；
                            占比 = 该段 ÷ 同行 prompt。
                            <br />
                            `–` = 该记录未落盘构成（本版前的旧轮）；窗口% = 该步 总输入+总输出 ÷ 上限（与环同源）；
                            压缩列 = 该步（请求）的压缩：**投递**=按当前配置（每轮首重建，**无需事件**）→ 悬停看预算/丢几条；
                            **压缩**=触发/手动事件（点开看算法/过滤器/规模）。
                            <Show when={compactPage()?.truncated}>
                                <div class="mt-1 text-warning" data-compact-truncated>
                                    ⓘ 更早的压缩记录未加载（审计日志，可清理）—— 只标注了最近 200 条压缩事件
                                </div>
                            </Show>
                        </div>
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
        // 时刻口径与对话流一致（fmtTurnStamp）：同一轮不该出现两种时间格式
        const c = fmtTurnStamp(s.id);
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
                    {/* 缓存时效柱（##477 追加）：与上面的环**不同维度**（时间 vs token），环保持不动 */}
                    <CacheAgeBar model={currentModelRef(localChatStore.trees)} />
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
 * **轮尾状态行**（末行恒显）—— 状态图标 + 时刻 + 统计 + ⚡速度 + 用量。
 *
 * 三段三种交互（2026-10-11 用户口径，别再合成一个按钮）：图标/时刻/统计与 ⚡速度都是**纯文本**
 * （没有"更多信息"可给；而滚屏阅读时视线与指针多半落在左侧，合成一个按钮就是一路误触），
 * 只有**用量**是靠右的按钮（hover 出 L2 卡、点击开 L3 抽屉，卡里的「明细」是同一动作第二个入口）。
 *
 * 状态图标（`✓/✗/⛔`）**只写字形，说明进 tooltip**（用户 2026-10-12：状态行上不写"正常结束"这类字）：
 * 判据 = `endReason`（##288 拍板），翻译见 lib/chat-fold 的 `endMarkOf`。
 *
 * ⚡速度 = **本轮最后一步**的生成速度（`总输出 ÷ (响应耗时 − TTFT)`，口径见 `shared/usage.stepRate`）。
 * 粒度就是"一步"：流内部的 token 计数拿不到，所以**跑着的那一步显示的是上一个已完成步的实测值**，
 * 该步一结束立刻刷新；轮次结束后这个值留在行上（"老的速度留在 bar 上"）。
 * 给不出数（本版之前的老记录没有该字段）就**不显示**，不拿假数占位。
 *
 * 时间用**日期+时间到秒**（2026-10-04 用户定）：轮次末尾要能定位"这话什么时候说的"，
 * 只给时分在同一天多轮、或跨天回看时无法定位。旧记录轮次也照样出时间（见下）。
 *
 * `stat`（步数 · 耗时 · ⚙ n · 💭 n · ❌ n）本文件**只负责摆**，内容与判据见
 * `LocalChatPage.turnStatLine`。
 *
 * **截断纪律**（##298）：这一行的每一段都 `min-w-0 truncate`（见 `CLIP`），**不再有 `shrink-0`** ——
 * 极窄栏（420px 窗口、侧栏占满后内容列只剩 ~88px）里几个 `shrink-0` 兄弟互不相让，行被顶破容器
 * 36px、并从 21px 涨到 37px（文本在 span 内折行）。谁先退场由**容器宽度**（不是窗口宽度）排：
 * 速度 → 统计 → 用量按钮 → 时刻，规则在 `index.css` 的状态行段（`@container`）。
 */
/** 状态行每一段的**截断纪律**（##298）：可缩（flex-shrink）+ 会截（ellipsis）。
 *  ⚠️ 极窄栏里**不要**给这些段 `shrink-0` —— 几个兄弟互不相让就把整行顶破容器。 */
const CLIP = "min-w-0 truncate";

export function TurnUsageBar(props: {
    /** 本轮 id（`t` + 毫秒）：时刻与速度分母的**唯一真源**（协议无块级 ts，见 fmtTurnClock） */
    turnId: string;
    usage: unknown;
    /** true = 直播中且 main 还没写过 usage patch（第一步 finish-step 之前）：给占位，不装作有数 */
    pending?: boolean;
    /** true = 本轮仍在跑：决定 ⚡速度是否显示、状态图标是否走"进行中" */
    live?: boolean;
    /** 本轮结束原因（`endReason`）——状态图标的判据；旧日志没有 → 不给图标 */
    end?: TurnEndReason | null;
    /** 本轮统计（步数 · 耗时 · ⚙ n · 💭 n · ❌ n），摆在这行、用量按钮左边；空则不占位 */
    stat?: string;
    hover: boolean;
    onHover: (el: HTMLElement) => void;
    onHoverEnd: () => void;
    onDetail: () => void;
}) {
    // 时间与记录格式无关（turnId 里就带着开始时刻）—— 旧记录轮次同样要能定位时间
    const clock = fmtTurnClock(props.turnId);
    /** 时刻：纯文本、无 hover、无点击（它没有"更多信息"可给，靠左却最容易误触）。
     *  `title` 是**截断后的出口**：极窄栏里 `truncate` 只留得住前几个字（`2026-10-…`），
     *  完整时刻仍要能查到（DOM 文本也是完整的，见 intent 用例）。 */
    const Clock = () => (
        <Show when={clock != null}>
            <span class={`${CLIP} tabular-nums text-caption opacity-50`} data-turn-clock title={clock!}>
                {clock}
            </span>
        </Show>
    );
    /** 本轮统计：与时刻同为**纯文本**（无 hover / 无点击）—— 它没有"更多信息"可给 */
    const Stat = () => (
        <Show when={props.stat}>
            <span class={`${CLIP} text-caption opacity-60`} data-turn-stat title={props.stat}>
                {props.stat}
            </span>
        </Show>
    );

    // ── 速度（##349 三档）：**同一位置按轮次生死换档**，避免两处重复同一数字
    //    · 直播中 = **实时档** ⚡（本轮最近一步的实测值；流内 token 计数拿不到，故非"跑着那一步"的实时）
    //    · 轮结束 = **轮均档** ⌀（本轮 Σ总输出 ÷ Σ各步响应耗时；给不出数回退逐步账本）
    //    无定时器：两档都只在每步结束时变（live 时每步追新，停后即为定值）。
    const isLive = () => !!props.live;
    const rate = () => (isLive() ? turnStepRate(props.turnId, props.usage) : turnAvgRate(props.turnId, props.usage));
    /** 速度：纯文本；给不出数（老记录 / 该步没有计时）就整块不画 */
    const Rate = () => (
        <Show when={rate() != null}>
            <span
                class={isLive()
                    ? `${CLIP} tabular-nums text-caption text-accent animate-pulse`
                    : `${CLIP} tabular-nums text-caption opacity-60`}
                data-turn-live-rate={isLive() ? "1" : undefined}
                data-turn-rate={isLive() ? undefined : "1"}
                title={isLive()
                    ? "实时速度 ⚡ = 本轮最近一步的总输出 ÷ 该步响应耗时（含首字等待 TTFT），每步结束刷新一次"
                    : "轮均速度 ⌀ = 本轮总输出 ÷ 本轮各步响应耗时之和（含首字等待 TTFT）"}
            >
                {isLive() ? "⚡" : "⌀"} {Math.round(rate()!)} tok/s
            </span>
        </Show>
    );

    // ── 状态图标：字形承载状态，说明只进 tooltip
    const mark = () => endMarkOf(props.end ?? null, !!props.live);
    const toneClass = () =>
        ({ live: "opacity-40", ok: "text-success", cut: "text-warning", err: "text-error", none: "" })[mark().tone];
    const StatusIcon = () => (
        <Show when={mark().icon}>
            <span
                class={`shrink-0 ${toneClass()}`}
                data-turn-end={mark().tone}
                title={mark().tip}
                aria-label={mark().tip}
            >
                {mark().icon}
            </span>
        </Show>
    );

    /** 直播首步还没跑完：时间照给（turnId 自带开始时刻），用量位给占位。
     *  ⚠️ 三个分支必须走 `<Switch>`，**不能** `if (...) return`：Solid 组件体只跑一次，
     *  提前 return 得到的分支在 usage 到达后不会重算 —— 占位条会永远留在那儿（实测坑）。 */
    const pending = () => !!props.pending && props.usage == null;
    return (
        <Switch>
            <Match when={pending()}>
                <div class="flex items-center gap-2 text-body" data-usage-pending="1" data-turn-status="1">
                    <RowGutter can={false} />
                    <StatusIcon />
                    <Clock />
                    <span class="flex-1" />
                    <Stat />
                    <Rate />
                    <span
                        class={`${CLIP} text-caption opacity-40`}
                        title="用量要等本步跑完（finish-step）才拿得到；时间是本轮开始时刻"
                    >
                        ⋯ 统计中
                    </span>
                </div>
            </Match>
            <Match when={isLegacyUsage(props.usage)}>{LegacyRow()}</Match>
            <Match when={true}>{LiveRow()}</Match>
        </Switch>
    );

    /** 旧记录：无四桶无金额 → 降级成一行字，不进卡不进抽屉（拆不出东西） */
    function LegacyRow() {
        const l = () => props.usage as { in?: number; out?: number; total?: number };
        return (
            <div class="flex items-center gap-2 text-body" data-turn-status="1">
                <RowGutter can={false} />
                <StatusIcon />
                <Clock />
                <span class="flex-1" />
                <Stat />
                <Rate />
                <span
                    class={`${CLIP} opacity-60`}
                    title="旧记录：无四桶/金额"
                >
                    tokens ↑{fmtInt(l().in ?? 0)} ↓{fmtInt(l().out ?? 0)}（Σ{fmtInt(l().total ?? 0)}）
                    <span class="ml-1">（旧记录：无四桶/金额）</span>
                </span>
            </div>
        );
    }

    /** 正常一轮：图标/时刻靠左 · 统计/速度/用量靠右 */
    function LiveRow() {
        const p = () => props.usage as TurnUsagePatch;
        return (
            <div class="flex items-center gap-2" data-turn-status="1">
                <RowGutter can={false} />
                <StatusIcon />
                <Clock />
                <span class="flex-1" />
                <Stat />
                <Rate />
                <button
                    type="button"
                    /* `w-max` 只是"不主动撑开"（宽度 = 内容），**不是"不可缩"** ——
                       极窄栏里它仍要能退让，否则它自己是最后一个顶破容器的。内部两段各自截断。 */
                    class={`flex min-w-0 cursor-pointer select-none items-center gap-x-3 rounded px-1 text-body opacity-70 transition-opacity hover:bg-base-200 hover:opacity-100 ${CLIP}`}
                    aria-haspopup="dialog"
                    aria-expanded={props.hover}
                    data-turn-usage
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
                    <span class={`${CLIP} tabular-nums`} data-turn-usage-tok>
                        {fmtTokens(p().total)} tok
                    </span>
                    <span
                        class={`${CLIP} tabular-nums`}
                        data-turn-usage-cost
                        title={p().unpriced ? `本轮 ${p().unpriced} 步无价目：金额只是已计价部分之和` : undefined}
                    >
                        {p().cost ? `$${fmtCost(p().cost!.total)}` : "$—"}{p().cost && p().unpriced ? "*" : ""}
                    </span>
                </button>
            </div>
        );
    }
}

// ─── L1③ 输入框底部总状态栏的速度（总均档） ──────────────

/**
 * ⌀ **全局平均**生成速度（常驻位，输入框底部工具条）。
 *
 * 口径（##349，用户 2026-10-15）：**总均** = 全部轮次 Σ总输出 ÷ Σ各步响应耗时（含首字等待，
 * `shared/usage.recordsAvgRate`）。为什么放在这里 —— 轮尾那行在对话流里、会随滚屏移出视野，
 * 而"整体跑得快不快"是常驻参考；且用户明确要求**避免与上方轮均重复同一数字**：
 * 轮尾给的是"本轮"，这里给的是"全局"，两者口径一致但范围不同，故可比而不重复。
 * 给不出数（新会话还没跑过步 / 老记录没有计时）→ 整块不画，不拿假数占位。
 */
export function OverallRateChip(props: {
    /** 全局平均速度（tok/s）；null → 不画 */
    rate: number | null;
}) {
    return (
        <Show when={props.rate != null}>
            <span
                class="shrink-0 tabular-nums text-caption opacity-60"
                data-overall-rate
                title="总均速度 ⌀ = 全部轮次总输出 ÷ 全部步响应耗时之和（含首字等待 TTFT）"
            >
                ⌀ {Math.round(props.rate!)} tok/s
            </span>
        </Show>
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
        // **跑过但无价目**（##372）→ 「$—」：这不是"花了 0 元"，是"没价钱可算"。
        // 混着有的（部分和）额外打 `*`，与页脚同口径。
        if (!a.cost) return `${fmtTokens(a.total)} tok · $—`;
        return `${fmtTokens(a.total)} tok · $${fmtCost(a.cost.total)}${a.unpriced > 0 ? "*" : ""}`;
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
        void navigator.clipboard
            .writeText(props.text())
            .then(() =>
                notificationStore.addToast(
                    "success",
                    "已复制到剪贴板",
                    copyOkMeta({ what: "格式化文本", text: props.text(), mech: "UsagePanel.tsx::FmtBody" }),
                ),
            )
            .catch((e: unknown) =>
                notificationStore.addToast(
                    "error",
                    "复制失败（剪贴板不可用）",
                    copyFailMeta({ what: "格式化文本", mech: "UsagePanel.tsx::FmtBody", error: e }),
                ),
            );
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

// ─── L3① 本轮逐步明细抽屉（旧两张表 → 一张双表头表） ───

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
    const clock = () => (props.turnId ? fmtTurnStamp(props.turnId) : null);
    /** 表格 / MD 源码 / 账本源码（两键皆不亮 = 表格；再点已亮键回表格） */
    const [fmtView, setFmtView] = createSignal<"table" | "md" | "raw">("table");
    const toggleFmt = (v: "md" | "raw") => setFmtView((x) => (x === v ? "table" : v));
    /** MD 导出与表格同一份列定义（`usageTableMd`），不再各写一套表头 */
    const mdText = () =>
        props.turnId ? usageTableMd(localChatStore.usage, "step", { field: "turnId", value: props.turnId }) : "";
    const rawText = () => rows().map((r) => JSON.stringify(r)).join("\n");

    const DM = useDrawerMax();
    return (
        <Show when={props.turnId}>
            {/* 形态（2026-10-03 定稿，与人物面板 PersonaDrawer 同构）：**全宽贴顶、高 2/3 屏** ——
                占满整个上半部分页面、下面只留 1/3 空位（用户点名，不再居中悬浮）。
                点遮罩 / ✕ / Escape 退出（Escape 在 LocalChatPage 的全局键处理里）。 */}
            <div class="fixed inset-0 z-50 flex flex-col" data-find-surface onClick={props.onClose}>
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
                        {/* 表 = 统一表的一个视图（group=step + turnId 过滤），不再有「本轮专用表」 */}
                        <Show when={props.turnId}>
                            {(id) => (
                                <UsageTable rows={localChatStore.usage} view="step" filter={{ field: "turnId", value: id() }} />
                            )}
                        </Show>
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

// ─── L3② 会话用量抽屉（= 统一表 + group 选项 + 下钻） ───

/**
 * 会话用量入口（L3）—— **唯一的用量表**（##443 刀 3）。
 *
 * 一个 group 选项切四个粒度 + 「窗口构成」，**不是四张表**：
 *   · 表体、表头、合计行、下钻全部由 `UsageTable` 按 `shared/usage-fields.ts` 的列契约渲染；
 *   · 下钻 = 同一张表换参数（`turn` 行 → step + turnId 过滤；`persona` 行 → turn + persona 过滤），
 *     面包屑只负责让你回得去 —— 不存在「另一张明细表」；
 *   · 合计行恒为 `session` 粒度那一行（与组行同源同口径），置顶（用户决策链：先看值不值）。
 *
 * 数字来源仍是 `localChatStore.usage`（`usage.jsonl` 镜像），打开时对账刷新一次。
 * 窗口环保留在顶部：那是「距上限多远」的常驻判断，不属于表格字段。
 */
export function UsageDrawer(props: { open: boolean; uri: string | null; onClose: () => void }) {
    // 每次打开顺手对一次账本：轮次间隙里**别人**（CLI / 另一窗口）跑的轮次，
    // 我这侧的下降沿重放会补，但打开看板这个动作本身就说明"我要看最新的数"，不该给旧值。
    createEffect(() => {
        if (props.open && props.uri) void localChatStore.refreshUsage(props.uri);
    });
    const steps = () => localChatStore.usage;

    // ─── 视图状态：一个 group + 一条下钻栈（栈顶的 view/filter 覆盖 group）───
    const [group, setGroup] = createSignal<UsageView>("step");
    const [stack, setStack] = createSignal<
        { view: UsageView; filter: { field: "turnId" | "persona"; value: string }; label: string }[]
    >([]);
    const effView = (): UsageView => stack().at(-1)?.view ?? group();
    const filter = () => stack().at(-1)?.filter;
    /** 切 group 一律清空下钻栈（否则 group=turn 还带着 turnId 过滤 = 空表） */
    const pick = (v: UsageView) => {
        setStack([]);
        setGroup(v);
    };
    const drill = (t: { view: UsageView; filter: { field: "turnId" | "persona"; value: string }; label: string }) =>
        setStack((st) => [...st, t]);
    const back = () => setStack((st) => st.slice(0, -1));

    // 压缩事件账 + 边界（步视图的「压缩点位」列与「投递裁剪」徽章 hover 要用；抽屉开着才查）
    const [compactPage] = createResource(
        () => (props.open ? props.uri : null),
        async (u) =>
            u
                ? ((await localChatStore.compactEvents(u)) as { events: CompactEventRecord[]; truncated: boolean })
                : { events: [] as CompactEventRecord[], truncated: false },
    );
    const [autoStatus] = createResource(
        () => (props.open ? props.uri : null),
        async (u) =>
            u
                ? ((await localChatStore.autoCompactStatus(u)) as unknown as {
                      facts?: { boundary?: { at: string; dropped: number; limitTokens: number } | null };
                  })
                : undefined,
    );
    /** `undefined` = 还没取到（徽章 hover 少一段，不编事实）；`null` = 确实没压过 */
    const boundary = (): DeliveryBoundary | null | undefined => {
        const st = autoStatus();
        if (!st) return undefined;
        return st.facts?.boundary ?? null;
    };

    /** 窗口占用取**最后一步**：上下文压力是当前状态，不是历史累加（##211 §三） */
    const last = () => {
        const list = steps();
        return list.length ? stepView(list[list.length - 1]!) : null;
    };
    const rate = () => (last() ? windowRate(last()!.buckets, last()!.record.contextLimit) : null);
    const tiers = () => [...new Set(steps().map((r) => r.rates?.tier).filter((t): t is string => !!t))];
    /** 时段档（峰/谷）——与上下文档位是**两轴**，分开显示（见 shared/usage.ts ratesOf） */
    const windows = () => [...new Set(steps().map((r) => r.rates?.window).filter((t): t is string => !!t))];
    /** 表格 / MD 源码 / 账本源码（两键皆不亮 = 表格；再点已亮键回表格） */
    const [fmtView, setFmtView] = createSignal<"table" | "md" | "raw">("table");
    const toggleFmt = (v: "md" | "raw") => setFmtView((x) => (x === v ? "table" : v));
    const mdText = () => usageTableMd(steps(), effView(), filter());
    const rawText = () => steps().map((r) => JSON.stringify(r)).join("\n");

    const GROUPS: { v: UsageView; label: string }[] = [
        { v: "step", label: "逐步" },
        { v: "turn", label: "按轮" },
        { v: "persona", label: "按人物" },
        { v: "session", label: "按会话" },
        { v: "contextParts", label: "窗口构成" },
    ];

    const DM = useDrawerMax();
    return (
        <Show when={props.open}>
            {/* 与 TurnUsageDetailDrawer 同款形态（与 PersonaDrawer 同构）：全宽贴顶、高 2/3 屏 */}
            <div class="fixed inset-0 z-50 flex flex-col" data-find-surface onClick={props.onClose}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl" style={DM.style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="text-title font-medium">用量</div>
                        <div class="join shrink-0" role="group" aria-label="用量分组">
                            <For each={GROUPS}>
                                {(g) => (
                                    <button
                                        class={`btn btn-xs join-item ${effView() === g.v ? "btn-active" : "btn-ghost"}`}
                                        aria-pressed={effView() === g.v}
                                        data-usage-group={g.v}
                                        onClick={() => pick(g.v)}
                                    >
                                        {g.label}
                                    </button>
                                )}
                            </For>
                        </div>
                        <div class="ml-auto">
                            <FmtToggle view={fmtView()} onView={toggleFmt} />
                        </div>
                        <DrawerMaxButton max={DM.max()} onToggle={DM.toggle} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose} aria-label="关闭用量">
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
                        {/* 窗口占用：用户点名的「最重要的一个数」——距上限多远、何时该重置（不是表格字段） */}
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
                            </div>
                        </div>

                        {/* 面包屑：下钻后回得去（同一张表换参数，栈里只记「从哪来」） */}
                        <Show when={stack().length > 0}>
                            <div class="mb-2 flex flex-wrap items-center gap-1 text-caption" data-usage-crumbs>
                                <button class="btn btn-ghost btn-xs" data-usage-back onClick={back}>
                                    ← 返回
                                </button>
                                <span class="opacity-60">会话</span>
                                <For each={stack()}>
                                    {(t) => (
                                        <>
                                            <span class="opacity-40">›</span>
                                            <span class="font-medium">{t.label}</span>
                                        </>
                                    )}
                                </For>
                            </div>
                        </Show>

                        <div class="mb-1 text-caption opacity-60" data-usage-scope>
                            {effView() === "step" ? "每行一步（点「按轮」看合计；轮内明细从这里下钻）" : null}
                            {effView() === "turn" ? "每行一轮（点行看该轮逐步）" : null}
                            {effView() === "persona" ? "每行一个人物（点行看该人物的轮）" : null}
                            {effView() === "session" ? "整个会话一行（合计口径，与其余视图同源）" : null}
                            {effView() === "contextParts" ? "每行一次请求的构成（字节÷4 估算，标 ~；高层不求和）" : null}
                        </div>

                        <UsageTable
                            rows={steps()}
                            view={effView()}
                            filter={filter()}
                            compactEvents={compactPage()?.events ?? []}
                            boundary={boundary()}
                            onDrill={drill}
                        />

                        <div class="mt-2 text-caption opacity-60">
                            单价依据 models.dev
                            {steps().find((r) => r.rates?.asOf)?.rates?.asOf
                                ? `@${steps().find((r) => r.rates?.asOf)!.rates!.asOf}`
                                : ""}
                            {" · "}
                            生效档位：{tiers().length ? tiers().join(", ") : "—"}
                            {windows().length ? ` · 时段：${windows().join(", ")}` : ""}
                            <br />
                            `合计$` = 非缓存 + 缓存读 + 缓存写 + 文本 + 思考；思考是总输出的拆解子项，
                            <span class="font-medium">不重复加</span>。缓存写 `–` = 该 API 面不可测（不是 0）。
                        </div>
                    </Show>
                    </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}

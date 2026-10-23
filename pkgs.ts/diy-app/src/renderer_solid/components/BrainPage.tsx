/**
 * BrainPage — 大脑页（**独立子页面**，用户 2026-10-23 拍板：与上下文树平行）。
 *
 * 一句话：把「agent 每步思考时脑子里到底放了什么、花了多少钱」摊开。
 * 上下文窗口 = 脑容量；system / runtime 投影 + 消息历史 = 每次思考的材料。
 *
 * 与既有页面的分工（刻意不重叠）：
 *   · 上下文树（ctxlab）：**变量变了什么**（树形、划分规则、diff）；
 *   · 流量页：**HTTP 记录**（逐字的请求 / 响应、头部、重试）；
 *   · 大脑页（本页）：**预算 × 材料 × 时间** —— 一次思考的钱花在哪（段账），
 *     多步之间谁在长（曲线），哪些步的形态值得看一眼（信号），以及记分（合并在本页，
 *     结果与原因必须同屏：只给分不给出处，人只能猜它是怎么来的）。
 *
 * 段的分组口径（`shared/context/mind.ts` 的真源）：**谁生成的、能不能减** ——
 * 不是「在哪个容器里」。所以是 `chain · ~/AGENTS.md` / `help` / `runtime.facts` /
 * `历史 · tool` 这个粒度，而不是 `system / runtime` 两个大桶（大桶永远看不出该砍谁）。
 *
 * 数据源：**内存里的流量记录**（`traffic.snapshot`，用户口径「先不存、用内存内的历史即可」）。
 * 不读磁盘日志、不做持久化 —— 需要跨天回看时再去流量页（那里是磁盘真源）。
 */
import { createResource, createSignal, For, Show, type JSX } from "solid-js";
import { diyService } from "../lib/rpc";
import { ViewGrid } from "./ViewGrid";
import { layoutStore } from "../store/layoutStore";
import { findPage } from "../../shared/view-registry";
import { parseStepRequest, type StepMessage } from "../../shared/context/step-request";
import { analyzeMind, mindTrend, repeatReads, type MindGroup, type MindSegment } from "../../shared/context/mind";
import { LayoutAreaToggles } from "./LayoutAreaToggles";

const PAGE = "brain";
/** 只算最近这么多步：一条完整请求可达 250 KB，全量重算会把页面卡死（如实标注，不静默截断） */
const MAX_STEPS = 40;

/** 人类可读字节数（1024 进制；与流量页 / 上下文树同口径） */
function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

function pct(n: number, d: number): string {
    if (!d) return "—";
    return `${((n / d) * 100).toFixed(1)}%`;
}

/** 流量记录里我们渲染用到的字段（`traffic.snapshot` 的 records 是其超集） */
interface Rec {
    id?: number;
    ts: number;
    taskUri: string | null;
    turnId: string | null;
    stepSeq?: number | null;
    attemptInStep?: number | null;
    status: number | null;
    model: string;
    reqBytes?: number;
    resBytes?: number;
    ms?: number;
    reqBody?: { head?: string; tail?: string; truncated?: boolean; totalBytes?: number } | null;
}

/** 一步 = 一条请求 + 它的段账 + 相邻步差分（「这一思考产生了多少动作」） */
interface BrainStep {
    step: number;
    ts: number;
    turnId: string;
    rec: Rec;
    messages: StepMessage[];
    segments: MindSegment[];
    totalBytes: number;
    byGroup: Record<MindGroup, number>;
    /** 本步之后的 assistant/tool 增量消息数（下一步才有；最后一步为 null） */
    outMessages: number | null;
    /** 本步之后用户是否只说了「继续 / ？」这类话（停滞信号；null = 没有下一步 / 不是这类话） */
    stalled: boolean;
    note: string;
}

/** 组的展示名与配色（一份表，别在 JSX 里散着写） */
const GROUP_META: Record<MindGroup, { label: string; cls: string }> = {
    history: { label: "历史重发", cls: "bg-error" },
    system: { label: "system 链", cls: "bg-warning" },
    runtime: { label: "runtime 投影", cls: "bg-info" },
    help: { label: "help（结构说明）", cls: "bg-success" },
    input: { label: "本轮输入", cls: "bg-primary" },
    tools: { label: "工具定义", cls: "bg-neutral" },
};

/** 用户「催」的话术（出现即说明上一步没推进；只认极短的一句，避免把真实提问算进来） */
const STALL_RE = /^(继续|？|\?|继续吧|go on|continue)[。．.！!？?\s]*$/i;

export function BrainPage(props: { uri: string }): JSX.Element {
    const [selected, setSelected] = createSignal<number | null>(null);
    const [openSeg, setOpenSeg] = createSignal<string | null>(null);

    /** 折叠块（模块级省略：本页两块都默认展开，折叠态不跨页记忆 —— 少一份要维护的状态） */
    const [fold, setFold] = createSignal<Record<string, boolean>>({});

    const load = async (): Promise<BrainStep[]> => {
        const snap = await diyService.diy.traffic.snapshot({ withRecords: true });
        const recs = (snap.records as unknown as Rec[]).filter(
            (r) =>
                r.taskUri === props.uri &&
                typeof r.stepSeq === "number" &&
                (r.attemptInStep ?? 1) === 1,
        );
        // 同一 (turnId, stepSeq) 只留首试（重试链是流量页的事；这里一步算一次钱）
        const seen = new Set<string>();
        const uniq = recs
            .sort((a, b) => a.ts - b.ts)
            .filter((r) => {
                const k = `${r.turnId}#${r.stepSeq}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            })
            .slice(-MAX_STEPS);

        const drafts = uniq.map((rec) => {
            const parsed = parseStepRequest(rec.reqBody);
            const mind = analyzeMind(parsed.messages ?? []);
            return { rec, messages: parsed.messages ?? [], note: parsed.note, ...mind };
        });

        return drafts.map((d, i): BrainStep => {
            const next = drafts[i + 1];
            const lastUser = next ? [...next.messages].reverse().find((m) => m.role === "user") : undefined;
            return {
                step: d.rec.stepSeq ?? i + 1,
                ts: d.rec.ts,
                turnId: d.rec.turnId ?? "",
                rec: d.rec,
                messages: d.messages,
                segments: d.segments,
                totalBytes: d.totalBytes,
                byGroup: d.byGroup,
                outMessages: next ? Math.max(0, next.messages.length - d.messages.length) : null,
                stalled: lastUser ? STALL_RE.test(lastUser.text.slice(-12).trim()) : false,
                note: d.note,
            };
        });
    };

    const [data, { refetch }] = createResource(load);

    const steps = (): BrainStep[] => data() ?? [];

    /**
     * 能算出段账的步数。**为什么要有这个数**：流量默认「只留首尾」（`truncated`），
     * 截断的请求体解不开 ⇒ 段账恒为空。实测本任务 412 条记录**全部**截断 —— 没有这个
     * 提示，用户打开本页看到的是一片 0，会以为是页坏了，而不是「去开个开关」。
     */
    const usable = (): number => steps().filter((s) => s.messages.length > 0).length;
    const [enabling, setEnabling] = createSignal(false);
    /** 就地开「记录完整请求内容」—— 用户不必先知道那开关在流量页的哪个角落 */
    const enableCapture = async (): Promise<void> => {
        setEnabling(true);
        try {
            await diyService.diy.traffic.setFullCapture({ on: true });
            await refetch();
        } catch (e) {
            console.error("开启全量捕获失败", e);
        } finally {
            setEnabling(false);
        }
    };
    const cur = (): BrainStep | null => {
        const list = steps();
        if (list.length === 0) return null;
        const want = selected();
        return list.find((s) => s.step === want) ?? list[list.length - 1]!;
    };

    const trend = () => mindTrend(steps().map((s) => ({ step: s.step, reqBytes: s.rec.reqBytes ?? s.totalBytes, byGroup: s.byGroup })));
    const dups = () => repeatReads(steps().map((s) => ({ step: s.step, toolCalls: s.messages.flatMap((m) => m.toolCalls) })));

    /** 段按字节降序（一次思考里最先该看的） */
    const segsOf = (s: BrainStep): MindSegment[] => [...s.segments].sort((a, b) => b.bytes - a.bytes);

    /** 预算堆叠条：一个 flex 条，宽度 = 占比（低于 0.5% 的段合并成「其它」，否则看不见） */
    const stack = (s: BrainStep): JSX.Element => {
        const total = s.segments.reduce((n, x) => n + x.bytes, 0) || 1;
        return (
            <div class="flex h-4 w-full overflow-hidden rounded border border-base-300" title="按段字节占比">
                <For each={segsOf(s)}>
                    {(seg) => (
                        <div
                            class={`${GROUP_META[seg.group].cls} h-full`}
                            style={{ width: `${(seg.bytes / total) * 100}%` }}
                            title={`${seg.key} · ${fmtBytes(seg.bytes)} · ${pct(seg.bytes, total)}`}
                        />
                    )}
                </For>
            </div>
        );
    };

    const Fold = (p: { k: string; label: string; extra?: string; children: JSX.Element }): JSX.Element => {
        const open = (): boolean => fold()[p.k] !== false;
        return (
            <div class="flex min-h-0 flex-col rounded-lg border border-base-300" classList={{ "flex-1 min-h-[140px]": open() }}>
                <div class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide">
                    <button class="flex items-center gap-1 opacity-80 hover:opacity-100" onClick={() => setFold({ ...fold(), [p.k]: !open() })}>
                        <span>{open() ? "▾" : "▸"}</span>
                        <span>{p.label}</span>
                    </button>
                    <span class="ml-auto font-mono text-body font-normal opacity-70">{p.extra}</span>
                </div>
                <Show when={open()}>
                    <div class="min-h-0 flex-1 overflow-auto bg-base-200 text-body">{p.children}</div>
                </Show>
            </div>
        );
    };

    // ─────────────────────────── 左：这次思考 ───────────────────────────

    const budgetPane = (): JSX.Element => {
        const s = cur();
        if (!s) return <div class="p-2 opacity-60">没有可分析的真发请求（本任务的流量记录为空或没有步号）。真发一轮后按「⟳ 刷新」。</div>;
        const req = s.rec.reqBytes ?? s.totalBytes;
        return (
            <div class="flex flex-col gap-1 p-1">
                {/* 步选择条 */}
                <div class="flex flex-wrap items-center gap-1">
                    <span class="badge badge-xs badge-outline font-mono">第 {s.step} 步</span>
                    <span class="font-mono text-caption opacity-70">{s.rec.model}</span>
                    <span
                        class="badge badge-xs"
                        classList={{ "badge-success": s.rec.status !== null && s.rec.status < 400, "badge-error": s.rec.status === null || s.rec.status >= 400 }}
                    >
                        {s.rec.status ?? "无响应"}
                    </span>
                    <span class="opacity-60">{fmtBytes(req)}</span>
                    <Show when={s.rec.ms}>
                        <span class="opacity-50">{`${s.rec.ms} ms`}</span>
                    </Show>
                </div>

                {/* 预算堆叠 */}
                <div class="flex flex-col gap-0.5">
                    {stack(s)}
                    <div class="flex flex-wrap gap-x-2 text-caption">
                        <For each={Object.keys(GROUP_META) as MindGroup[]}>
                            {(g) => (
                                <Show when={s.byGroup[g] > 0}>
                                    <span class="flex items-center gap-1">
                                        <span class={`inline-block h-2 w-2 rounded-sm ${GROUP_META[g].cls}`} />
                                        <span class="opacity-70">{GROUP_META[g].label}</span>
                                        <span class="font-mono opacity-50">{pct(s.byGroup[g], s.totalBytes)}</span>
                                    </span>
                                </Show>
                            )}
                        </For>
                    </div>
                </div>

                {/* 段明细：点一行看该段原文（量的和看的是同一份，不二次加工） */}
                <table class="table table-xs">
                    <thead>
                        <tr>
                            <th>段</th>
                            <th class="text-right">字节</th>
                            <th class="text-right">占比</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={segsOf(s)}>
                            {(seg) => (
                                <tr
                                    class="cursor-pointer hover:bg-base-300/60"
                                    classList={{ "bg-base-300/40": openSeg() === seg.key }}
                                    onClick={() => setOpenSeg(openSeg() === seg.key ? null : seg.key)}
                                >
                                    <td class="font-mono">{seg.key}</td>
                                    <td class="text-right font-mono">{fmtBytes(seg.bytes)}</td>
                                    <td class="text-right font-mono opacity-60">{pct(seg.bytes, s.totalBytes)}</td>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
                <Show when={openSeg()}>
                    {(k) => {
                        const seg = s.segments.find((x) => x.key === k());
                        return (
                            <div class="flex flex-col gap-0.5">
                                <div class="flex items-center gap-1 text-caption opacity-70">
                                    <span class="badge badge-xs badge-ghost">{k()}</span>
                                    <span>{`${fmtBytes(seg?.bytes ?? 0)} · 原文（逐字，就是被计入预算的那份）`}</span>
                                </div>
                                <pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded bg-base-100 p-1 font-mono text-caption">
                                    {seg?.text ?? "（段已消失，刷新后重试）"}
                                </pre>
                            </div>
                        );
                    }}
                </Show>
                <Show when={s.note}>
                    <div class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-caption">{s.note}</div>
                </Show>
            </div>
        );
    };

    /** 记分 v0：**只报可算的东西，不编"质量分"**。原因写在卡片里，免得数字被当成结论。 */
    const scorePane = (): JSX.Element => {
        const s = cur();
        if (!s) return <div class="p-2 opacity-60">—</div>;
        const req = s.rec.reqBytes ?? s.totalBytes;
        const historyShare = s.totalBytes > 0 ? s.byGroup.history / s.totalBytes : 0;
        const cells: { k: string; v: string; hint: string; bad?: boolean }[] = [
            { k: "投入", v: fmtBytes(req), hint: "这一步真发出去的请求字节（含历史重发）" },
            { k: "历史占比", v: pct(s.byGroup.history, s.totalBytes), hint: "历史重发 / 本次总字节 —— 高于 70% 说明脑容量被过去占满", bad: historyShare > 0.7 },
            { k: "动作数", v: s.outMessages === null ? "—" : String(s.outMessages), hint: "本步之后新增的 assistant/tool 消息数（没有下一步就无法量）" },
            { k: "停滞", v: s.stalled ? "是" : "否", hint: "下一步用户只说了「继续 / ？」—— 上一步没推进", bad: s.stalled },
        ];
        return (
            <div class="flex flex-col gap-1 p-1">
                <div class="grid grid-cols-2 gap-1">
                    <For each={cells}>
                        {(c) => (
                            <div class="rounded border border-base-300 px-2 py-1">
                                <div class="text-caption opacity-60">{c.k}</div>
                                <div class="font-mono text-body" classList={{ "text-error": !!c.bad }}>
                                    {c.v}
                                </div>
                                <div class="text-caption opacity-50">{c.hint}</div>
                            </div>
                        )}
                    </For>
                </div>
                <div class="rounded border border-info/40 bg-info/10 px-2 py-1 text-caption leading-snug">
                    {`记分 v0 只摆**可量的事实**：投入多少、历史占多少、这一步产生了多少动作、有没有被催。` +
                        `回答质量的自动评估还没定判据（LLM 判官 / 人工抽样 / 任务验收）—— 在那之前不给"总分"，` +
                        `否则一个编出来的数字会被当成结论。`}
                </div>
            </div>
        );
    };

    // ─────────────────────────── 中：多步趋势 ───────────────────────────

    const timelinePane = (): JSX.Element => {
        const list = steps();
        if (list.length === 0) return <div class="p-2 opacity-60">没有可分析的真发请求。</div>;
        const t = trend();
        const maxReq = Math.max(...t.steps.map((x) => x.reqBytes), 1);
        const W = 100;
        const H = 100;
        const pts = (sel: (x: (typeof t.steps)[number]) => number): string =>
            t.steps
                .map((x, i) => {
                    const px = t.steps.length === 1 ? W / 2 : (i / (t.steps.length - 1)) * W;
                    const py = H - (sel(x) / maxReq) * H;
                    return `${px.toFixed(2)},${py.toFixed(2)}`;
                })
                .join(" ");
        return (
            <div class="flex flex-col gap-1 p-1">
                <div class="flex flex-wrap items-center gap-2 text-caption">
                    <span class="badge badge-xs badge-ghost">{`最近 ${list.length} 步（内存记录）`}</span>
                    <span class="opacity-60">{`峰值 ${fmtBytes(maxReq)}`}</span>
                    <Show when={t.historyHeavyAt !== null}>
                        <span class="badge badge-xs badge-error">{`第 ${t.historyHeavyAt} 步起历史 >70%`}</span>
                    </Show>
                </div>
                {/* 曲线：req（总投入）与 history（历史重发）两条，归一化到同一坐标 */}
                <div class="rounded border border-base-300 bg-base-100 p-1">
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="h-24 w-full">
                        <polyline points={pts((x) => x.historyBytes)} fill="none" stroke="currentColor" class="text-error" stroke-width="0.8" vector-effect="non-scaling-stroke" />
                        <polyline points={pts((x) => x.reqBytes)} fill="none" stroke="currentColor" class="text-primary" stroke-width="0.8" vector-effect="non-scaling-stroke" />
                    </svg>
                    <div class="flex gap-3 text-caption opacity-70">
                        <span class="flex items-center gap-1">
                            <span class="inline-block h-0.5 w-3 bg-primary" />总投入
                        </span>
                        <span class="flex items-center gap-1">
                            <span class="inline-block h-0.5 w-3 bg-error" />历史重发
                        </span>
                    </div>
                </div>

                {/* 逐步表：点一行 → 左栏切到那一步 */}
                <table class="table table-xs">
                    <thead>
                        <tr>
                            <th class="text-right">步</th>
                            <th class="text-right">投入</th>
                            <th class="text-right">历史</th>
                            <th class="text-right">占比</th>
                            <th class="text-right">动作</th>
                            <th>形态</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={list}>
                            {(s) => {
                                const req = s.rec.reqBytes ?? s.totalBytes;
                                const share = s.totalBytes > 0 ? s.byGroup.history / s.totalBytes : 0;
                                return (
                                    <tr
                                        class="cursor-pointer hover:bg-base-300/60"
                                        classList={{ "bg-primary/15": cur()?.step === s.step }}
                                        onClick={() => setSelected(s.step)}
                                    >
                                        <td class="text-right font-mono">{s.step}</td>
                                        <td class="text-right font-mono">{fmtBytes(req)}</td>
                                        <td class="text-right font-mono opacity-70">{fmtBytes(s.byGroup.history)}</td>
                                        <td class="text-right font-mono" classList={{ "text-error": share > 0.7, "text-warning": share > 0.5 && share <= 0.7 }}>
                                            {pct(s.byGroup.history, s.totalBytes)}
                                        </td>
                                        <td class="text-right font-mono">{s.outMessages ?? "—"}</td>
                                        <td class="whitespace-nowrap">
                                            <Show when={s.stalled}>
                                                <span class="badge badge-xs badge-warning" title="下一步用户只说了「继续 / ？」">停滞</span>
                                            </Show>
                                        </td>
                                    </tr>
                                );
                            }}
                        </For>
                    </tbody>
                </table>
            </div>
        );
    };

    const signalPane = (): JSX.Element => {
        const d = dups();
        return (
            <div class="flex flex-col gap-1 p-1">
                <Show
                    when={d.length > 0}
                    fallback={<div class="text-caption opacity-60">没有重复读（同工具 + 同参数的调用都只出现一次）。</div>}
                >
                    <table class="table table-xs">
                        <thead>
                            <tr>
                                <th>重复的调用（同参数）</th>
                                <th class="text-right">次数</th>
                                <th>步</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={d}>
                                {(x) => (
                                    <tr>
                                        <td class="font-mono">{x.what}</td>
                                        <td class="text-right font-mono text-warning">{x.times}</td>
                                        <td class="font-mono opacity-70">{x.steps.join(", ")}</td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                </Show>
                <div class="rounded border border-base-300 px-2 py-1 text-caption opacity-60 leading-snug">
                    判据：同一步里「工具 + 参数」完全相同被调 ≥2 次。参数不同就是不同的活儿（`rg a` 与 `rg b`），
                    报它等于把正常工作算成异常。列表会随后续步数增长 —— 这是**形态**证据，不是缺陷判定。
                </div>
            </div>
        );
    };

    const parts: Record<string, () => JSX.Element> = {
        "brain.budget": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-body">
                <Fold k="budget" label="脑容量账（这一次思考）" extra={cur() ? `${fmtBytes(cur()!.totalBytes)} / ${segsOf(cur()!).length} 段` : "无数据"}>
                    {budgetPane()}
                </Fold>
                <Fold k="score" label="记分 v0（可量的事实）" extra={cur() ? `第 ${cur()!.step} 步` : "—"}>
                    {scorePane()}
                </Fold>
            </div>
        ),
        "brain.timeline": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-body">
                <Fold k="trend" label="脑容量趋势（多步）" extra={`${steps().length} 步`}>
                    {timelinePane()}
                </Fold>
                <Fold k="signal" label="信号（重复读 / 停滞）" extra={`${dups().length} 项`}>
                    {signalPane()}
                </Fold>
            </div>
        ),
    };

    return (
        <div class="flex h-full flex-col overflow-hidden">
            <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-body">
                <span class="badge badge-info badge-sm" title={props.uri}>
                    🧠 {props.uri}
                </span>
                <button
                    class="btn btn-xs btn-ghost"
                    title="重新从内存流量记录算一遍（没有实时推送：真发一轮后按一下）"
                    onClick={() => void refetch()}
                >
                    ⟳ 刷新
                </button>
                <span class="opacity-60">
                    {data.loading
                        ? "计算中…"
                        : data.error
                          ? `失败：${String(data.error)}`
                          : `最近 ${steps().length} 步 · 数据 = 内存流量记录（不落盘、不追溯启动前）`}
                </span>
                <div class="flex-1" />
                <LayoutAreaToggles page={findPage(PAGE)!} ctx={props.uri} />
            </div>
            {/* 段账不可用时的显式降级：整片 0 必须有一句话解释 + 一个能直接点的修法 */}
            <Show when={steps().length > 0 && usable() === 0}>
                <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 text-caption">
                    <span class="badge badge-warning badge-xs">段账不可用</span>
                    <span class="opacity-80">
                        {`这 ${steps().length} 步的请求体都被截断（默认只留首尾一段，解不开就数不出段）—— 不是没有上下文，是没记全。`}
                    </span>
                    <button class="btn btn-xs btn-warning" disabled={enabling()} onClick={() => void enableCapture()}>
                        {enabling() ? "开启中…" : "开启全量录制，再真发一轮"}
                    </button>
                    <span class="opacity-50">
                        （等价于流量页「记录完整请求内容」/ `traffic setFullCapture true`；本页字节仍按 `reqBytes` 出行，只是拆不出段）
                    </span>
                </div>
            </Show>
            <Show when={steps().length > 0 && usable() > 0 && usable() < steps().length}>
                <div class="shrink-0 border-b border-base-300 bg-base-200/40 px-3 py-1 text-caption opacity-70">
                    {`${steps().length} 步里有 ${usable()} 步能拆段，其余请求体被截断（开「记录完整请求内容」后新发的请求才可拆）`}
                </div>
            </Show>
            <div class="min-h-0 flex-1">
                <ViewGrid
                    pageId={PAGE}
                    ctx={props.uri}
                    layout={findPage(PAGE)!.layout}
                    binding={layoutStore.bindingFor(findPage(PAGE)!, props.uri)}
                    renderView={(viewId) => parts[viewId]?.() ?? <div class="p-3 text-body opacity-60">未注册的 view: {viewId}</div>}
                />
            </div>
        </div>
    );
}

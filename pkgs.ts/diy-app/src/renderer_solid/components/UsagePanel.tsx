/**
 * UsagePanel — 用量可见性的三个展示面（契约见任务 211 §六b）：
 *   ① TurnUsageFooter —— 对话流每轮页脚（收起态一行 + 点开逐步明细）
 *   ② UsageDrawer —— 会话看板（按「人物+模型+面+档位」分行的表格 + 窗口占用条）
 *
 * 为什么单独一个文件：这三块共用同一套术语与格式化（总输入 = 非缓存+缓存读+缓存写，
 * 总输出 = 文本+思考，思考是总输出的子集**不另加价**），散在 LocalChatPage 里会
 * 各自长出一套写法 —— 而"数字口径走样"正是本任务要消灭的东西。
 *
 * 数字来源两条，**不许混**：
 *   · 页脚 = turn 块属性（main 每步 patch，实时可得，含流式中未落盘的当步）
 *   · 明细/看板 = `<key>.usage.jsonl` 的结构化镜像（localChatStore.usage）
 */

import { createEffect, createSignal, For, Show } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import {
    cacheHitRate,
    fmtCost,
    fmtInt,
    fmtTokens,
    groupByAgent,
    groupByTurn,
    stepView,
    windowRate,
    type StepUsageRecord,
    type TurnUsagePatch,
    type UsageBuckets,
} from "../../shared/usage";
import { IconExpand } from "./icons";

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

/** 组成项：`非缓存54+缓存读198`；缓存写**不可测时省略**（不写成 0） */
function inputCompose(b: Pick<UsageBuckets, "noCache" | "cacheRead" | "cacheWrite">): string {
    const parts = [`非缓存${fmtTokens(b.noCache)}`, `缓存读${fmtTokens(b.cacheRead)}`];
    if (b.cacheWrite != null) parts.push(`缓存写${fmtTokens(b.cacheWrite)}`);
    return parts.join("+");
}

function outputCompose(b: Pick<UsageBuckets, "text" | "reasoning">): string {
    return `文本${fmtTokens(b.text)}+思考${fmtTokens(b.reasoning)}`;
}

/** 不可测桶 → `–`（与 0 区分：0 是"实测为零"这个另一个事实） */
const optCell = (n: number | null | undefined): string => (n == null ? "–" : fmtTokens(n));

function cellMs(ms: number | undefined): string {
    if (ms == null) return "–";
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const faceLabel = (api: string): string => (api === "responses" ? "resp" : "chat");

// ─── ① turn 页脚 + 逐步明细 ───────────────────────────

/**
 * 旧版 ops.jsonl 里的 usage 属性只有 {in,out,cached,total}（无四桶字段）。
 * 历史日志是 append-only 的史书，读侧必须兼容 —— 不当成"没有用量"，也不假装它是新格式。
 */
function isLegacyUsage(u: unknown): boolean {
    const r = u as Record<string, unknown> | null;
    return !!r && typeof r["noCache"] !== "number";
}

export function TurnUsageFooter(props: {
    turnId: string;
    usage: unknown;
    /** 本轮是否正在直播（main 报活跃）。决定"账本还没写全"是正常态还是异常态 */
    live: boolean;
    /** 展开态**存在组件外**（按 turnId 索引，像 pinned 那样）：块树每帧全量重建，
     *  组件局部 signal 会被清掉 —— 存里面就会出现"点开又自动合上/点了没反应"。
     *  根因（D4）另立 ##236，但展开态这条本任务内就得对。 */
    open: boolean;
    onToggle: (turnId: string) => void;
}) {
    const toggle = () => props.onToggle(props.turnId);
    /** 本轮的逐步明细（按 turnId 从账本快照里取） */
    const rows = (): StepUsageRecord[] => localChatStore.usage.filter((r) => r.turnId === props.turnId);

    const u = (): TurnUsagePatch | null =>
        isLegacyUsage(props.usage) ? null : (props.usage as TurnUsagePatch);
    const legacy = (): { in?: number; out?: number; cached?: number; total?: number } =>
        (props.usage ?? {}) as { in?: number; out?: number; cached?: number; total?: number };

    const rate = (): number | null => {
        const p = u();
        return p ? windowRate({ total: p.windowTotal }, p.contextLimit ?? undefined) : null;
    };

    // 展开时对齐账本：明细读的是 `<key>.usage.jsonl` 的镜像快照，而它只在
    // 进会话 / 轮末 / 打开看板时刷新 —— 少了这一下，会话未停时展开明细会扑空
    // （页脚已有数字、明细却说"没有记录"，D1 的自相矛盾）。
    // 只在"展开"这一动作上刷新：用户主动动作 + 一次 RPC，代价可接受；不做轮询。
    createEffect(() => {
        const u = localChatStore.currentUri;
        if (props.open && u) void localChatStore.refreshUsage(u);
    });

    return (
        <div class="text-[11px]">
            {/* 页脚两行，**两个口径各占一行、并标明范围**（这是必须的，不是啰嗦）：
                  行1 = 上下文压力（取**最后一步**，与窗口占用同源，相除自洽）；
                  行2 = 本轮成本（**各步累加**，解释"这轮为什么贵"）。
                40 步的一轮里，累加能到 1M 而真实上下文只有 44k —— 两者并排不标注，
                用户相除必然得出"窗口 96%"的假象（实测踩过）。 */}
            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <Show
                    when={u()}
                    fallback={
                        /* 旧记录降级：无四桶字段，按当时的口径原样呈现（不假装能拆开） */
                        <span class="opacity-60">
                            tokens ↑{legacy().in ?? 0} ↓{legacy().out ?? 0}（Σ{legacy().total ?? 0}）
                            <span class="ml-1">（旧记录：无四桶/金额）</span>
                        </span>
                    }
                >
                    {(p) => (
                        <button
                            type="button"
                            class="w-full cursor-pointer select-none text-left"
                            aria-expanded={props.open}
                            aria-label="展开本轮逐步用量"
                            onPointerDown={(e) => e.preventDefault()}
                            onClick={toggle}
                        >
                            {/* 行1：上下文（与窗口%同源，两数可相除） */}
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 opacity-70">
                                <span class={pctClass(rate())} title="窗口占用 = 最后一步的总输入 + 总输出 ÷ 模型上下文上限">
                                    窗口 {pctText(rate())}
                                </span>
                                <span title="当前上下文大小 = 最后一步的总输入 + 总输出（不是各步累加）">
                                    当前上下文 {fmtTokens(p().windowTotal)}
                                    {p().contextLimit ? ` / ${fmtTokens(p().contextLimit!)}` : ""}
                                    {/* 老会话没有分步输入/输出字段 → 只给总数，不编算式 */}
                                    <Show when={p().lastInputTotal != null && p().lastOutputTotal != null}>
                                        （= 总输入 {fmtTokens(p().lastInputTotal!)} + 总输出{" "}
                                        {fmtTokens(p().lastOutputTotal!)}）
                                    </Show>
                                </span>
                            </div>
                            {/* 行2：本轮成本（累加口径，标明它解释什么） */}
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 opacity-60">
                                <span title="本轮各步的总输入之和：每一步都要重发整个上下文，故它衡量的是「这轮重发成本」">
                                    本轮{p().steps != null ? ` ${p().steps} 步` : ""}累计 ↑总输入{" "}
                                    {fmtTokens(p().inputTotal)}（{inputCompose(p())}）
                                </span>
                                <span title="总输出 = 文本输出 + 思考输出；思考是总输出的子集，不另加价">
                                    ↓总输出 {fmtTokens(p().outputTotal)}（{outputCompose(p())}）
                                </span>
                                <span title="本轮累计金额（各步按各自生效单价计算后相加）">
                                    {p().cost ? `$${fmtCost(p().cost!.total)}` : "金额 n/a"}
                                </span>
                                <span class="opacity-70">{props.open ? "▴ 明细" : "› 明细"}</span>
                            </div>
                        </button>
                    )}
                </Show>
            </div>

            <Show when={props.open}>
                <TurnUsageDetail turnId={props.turnId} rows={rows()} live={props.live} />
            </Show>
        </div>
    );
}

/** 本轮逐步明细（每行自带人物/模型/面/档位：同一会话里这些会变，不能挂在标题上） */
function TurnUsageDetail(props: { turnId: string; rows: StepUsageRecord[]; live: boolean }) {
    const turns = () => groupByTurn(localChatStore.usage).filter((g) => g.turnId === props.turnId);
    return (
        <div class="mt-1 overflow-x-auto rounded-box border border-base-300 bg-base-100 p-2">
            <Show
                when={props.rows.length > 0}
                fallback={
                    /* 两种"还没有记录"必须分开说 —— 把正常态说成故障会让人白查一圈（D1）：
                       · 本轮还在跑：账本按步追加，此刻可能确实还没落到文件 → 正常，等一下；
                       · 本轮已停：确实没有记录（会话早于用量落盘上线，或写入失败）。 */
                    <div class="text-[11px] opacity-50">
                        {props.live
                            ? "本轮还在进行中，逐步账本按步写入，稍后即可见。"
                            : "这一轮没有逐步记录（该会话早于用量落盘上线，或账本写入失败）。"}
                    </div>
                }
            >
                <table class="table table-xs w-full whitespace-nowrap">
                    <thead>
                        <tr>
                            <th>步</th>
                            <th>人物</th>
                            <th>模型</th>
                            <th>面</th>
                            <th>档位</th>
                            <th class="text-right">非缓存输入</th>
                            <th class="text-right">缓存读</th>
                            <th class="text-right">缓存写</th>
                            <th class="text-right">总输出（文本+思考）</th>
                            <th class="text-right">耗时</th>
                            <th class="text-right">TTFT</th>
                            <th class="text-right">窗口%</th>
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
                                        <td class="text-right">{optCell(v().buckets.cacheWrite)}</td>
                                        <td class="text-right">
                                            {fmtInt(v().buckets.outputTotal)}（
                                            {fmtInt(v().buckets.text)}+{fmtInt(v().buckets.reasoning)}）
                                        </td>
                                        <td class="text-right">{cellMs(r.performance?.stepTimeMs)}</td>
                                        <td class="text-right">{cellMs(r.performance?.timeToFirstOutputMs)}</td>
                                        <td class={`text-right ${pctClass(v().windowRate)}`}>
                                            {pctText(v().windowRate)}
                                        </td>
                                        <td class="text-right">{v().cost ? fmtCost(v().cost!.total) : "n/a"}</td>
                                    </tr>
                                );
                            }}
                        </For>
                    </tbody>
                </table>

                {/* 金额细分：单价按**每步**那时的生效档位算（同一轮内 tier 也可能翻档），
                    故逐行给出单价快照，而不是汇总一个价。 */}
                <table class="table table-xs mt-1 w-full whitespace-nowrap">
                    <thead>
                        <tr>
                            <th>步</th>
                            <th>单价快照（$/1M，生效档）</th>
                            <th class="text-right">非缓存$</th>
                            <th class="text-right">缓存读$</th>
                            <th class="text-right">缓存写$</th>
                            <th class="text-right">文本$</th>
                            <th class="text-right">思考$</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={props.rows}>
                            {(r) => {
                                const v = () => stepView(r);
                                const rt = () => r.rates;
                                return (
                                    <tr>
                                        <td>{r.step}</td>
                                        <td class="opacity-70">
                                            <Show
                                                when={rt()}
                                                fallback={<span>无价目（该模型不在价格表内）</span>}
                                            >
                                                {(x) => (
                                                    <span>
                                                        {x().input}/{x().output}/{x().cacheRead ?? "–"}/
                                                        {x().cacheWrite ?? "–"} · {x().tier}
                                                    </span>
                                                )}
                                            </Show>
                                        </td>
                                        <td class="text-right">{v().cost ? fmtCost(v().cost!.noCache) : "n/a"}</td>
                                        <td class="text-right">{v().cost ? fmtCost(v().cost!.cacheRead) : "n/a"}</td>
                                        <td class="text-right">
                                            {v().cost?.cacheWrite == null ? "n/a" : fmtCost(v().cost!.cacheWrite!)}
                                        </td>
                                        <td class="text-right">{v().cost ? fmtCost(v().cost!.text) : "n/a"}</td>
                                        <td class="text-right">{v().cost ? fmtCost(v().cost!.reasoning) : "n/a"}</td>
                                    </tr>
                                );
                            }}
                        </For>
                    </tbody>
                </table>

                {/* 本轮合计：token 桶 + 金额。思考单列但**明确写清它已含在总输出里**，
                    否则会被读成第 5 个计费桶（重复计费的入口正是这种误读）。 */}
                <Show when={turns()[0]}>
                    {(g) => (
                        <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] opacity-70">
                            <span>
                                计费桶：非缓存 {fmtTokens(g().buckets.noCache)} · 缓存读{" "}
                                {fmtTokens(g().buckets.cacheRead)} · 缓存写 {optCell(g().buckets.cacheWrite)} · 总输出{" "}
                                {fmtTokens(g().buckets.outputTotal)}（{outputCompose(g().buckets)}）
                            </span>
                            <span>
                                合计 = 输入 3 项 + 文本 + 思考（思考是总输出的拆解子项，不额外加）
                            </span>
                            <Show when={g().unpriced > 0}>
                                <span class="text-warning">
                                    {g().unpriced} 步无金额快照（模型不在价格表内），合计为部分和
                                </span>
                            </Show>
                        </div>
                    )}
                </Show>
            </Show>
        </div>
    );
}

// ─── ② 会话看板（抽屉） ───────────────────────────────

/**
 * 会话用量看板。
 *
 * 内容顺序照用户的决策链：**先看窗口占用**（决定要不要重置）→ 再看花了多少（决定值不值）
 * → 最后看单价依据（为什么是这个数）。行键 = 人物+模型+面+档位（同一会话换过模型就多行），
 * 与 CLI 的 `--by-agent` 同源同口径。
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
    const totalCost = () => {
        const groups = groupByAgent(steps());
        const priced = groups.filter((g) => g.cost != null);
        return priced.reduce((sum, g) => sum + g.cost!.total, 0);
    };
    const hit = () => {
        const groups = groupByAgent(steps());
        const acc = groups.reduce(
            (a, g) => ({ cacheRead: a.cacheRead + g.buckets.cacheRead, inputTotal: a.inputTotal + g.buckets.inputTotal }),
            { cacheRead: 0, inputTotal: 0 },
        );
        return cacheHitRate(acc);
    };
    const tiers = () => [
        ...new Set(steps().map((r) => r.rates?.tier).filter((t): t is string => !!t)),
    ];

    return (
        <Show when={props.open}>
            <div class="fixed inset-0 z-50 flex justify-end" onClick={props.onClose}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative h-full w-[min(920px,95vw)] overflow-y-auto border-l border-base-300 bg-base-100 p-4 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class="mb-3 flex items-center justify-between">
                        <div class="text-sm font-medium">会话用量</div>
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            关闭
                        </button>
                    </div>

                    <Show
                        when={steps().length > 0}
                        fallback={
                            <div class="text-xs opacity-60">
                                还没有用量记录。跑一轮本地 agent 后，每步会写入 $DIY_HOME/local/&lt;key&gt;.usage.jsonl。
                            </div>
                        }
                    >
                        {/* 窗口占用：用户点名的「最重要的一个数」——距上限多远、何时该重置 */}
                        <div class="mb-3 rounded-box border border-base-300 p-3">
                            <div class="mb-1 flex items-baseline justify-between">
                                <span class="text-xs opacity-70">窗口占用（= 总输入 + 总输出，取最近一步）</span>
                                <span class={`text-sm font-medium ${pctClass(rate())}`}>{pctText(rate())}</span>
                            </div>
                            <progress
                                class={`progress w-full ${rate() != null && rate()! >= 0.9 ? "progress-error" : rate() != null && rate()! >= 0.75 ? "progress-warning" : "progress-success"}`}
                                value={Math.min(100, (rate() ?? 0) * 100)}
                                max="100"
                            />
                            <div class="mt-1 text-[11px] opacity-60">
                                {last()
                                    ? `${fmtInt(last()!.buckets.total)} / ${last()!.record.contextLimit ? fmtInt(last()!.record.contextLimit!) : "—"} tokens（= 总输入 ${fmtInt(last()!.buckets.inputTotal)} + 总输出 ${fmtInt(last()!.buckets.outputTotal)}）`
                                    : "—"}
                                <Show when={last()?.record.contextLimit}>
                                    {(lim) => (
                                        <span class="ml-1">
                                            · 距上限还有{" "}
                                            {fmtInt(Math.max(0, lim() - (last()?.buckets.total ?? 0)))} tokens
                                        </span>
                                    )}
                                </Show>
                            </div>
                            {/* 单次请求实况：最近一次提交了多少 token、其中缓存命中多少
                                （与后台对账时最先要看的两个数） */}
                            <Show when={last()}>
                                {(v) => (
                                    <div class="mt-1 text-[11px] opacity-60">
                                        最近一次请求：提交 {fmtInt(v().buckets.inputTotal)} tokens（非缓存{" "}
                                        {fmtInt(v().buckets.noCache)} + 缓存读 {fmtInt(v().buckets.cacheRead)}
                                        {v().buckets.cacheWrite != null ? ` + 缓存写 ${fmtInt(v().buckets.cacheWrite!)}` : ""}
                                        ），产出 {fmtInt(v().buckets.outputTotal)}（{outputCompose(v().buckets)}）
                                    </div>
                                )}
                            </Show>
                            <div class="mt-1 text-[11px] opacity-60">
                                缓存命中率 {hit() == null ? "—" : `${(hit()! * 100).toFixed(1)}%`}（缓存读 ÷
                                总输入，全会话）
                            </div>
                        </div>

                        {/* 按 人物+模型+面+档位 分行：token 主体 */}
                        <div class="mb-2 text-xs opacity-70">按「人物 + 模型 + 面 + 档位」分行</div>
                        <div class="overflow-x-auto">
                            <table class="table table-xs w-full whitespace-nowrap">
                                <thead>
                                    <tr>
                                        <th>人物</th>
                                        <th>模型</th>
                                        <th>面</th>
                                        <th>档位</th>
                                        <th class="text-right">步</th>
                                        <th class="text-right">总输入（非缓存+读+写）</th>
                                        <th class="text-right">总输出（文本+思考）</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={groupByAgent(steps())}>
                                        {(g) => (
                                            <tr>
                                                <td>{g.persona}</td>
                                                <td>{g.model}</td>
                                                <td>{faceLabel(g.apiFace)}</td>
                                                <td>{g.reasoningEffort}</td>
                                                <td class="text-right">{g.stepCount}</td>
                                                <td class="text-right">
                                                    {fmtTokens(g.buckets.inputTotal)}（
                                                    {inputCompose(g.buckets)}）
                                                </td>
                                                <td class="text-right">
                                                    {fmtTokens(g.buckets.outputTotal)}（
                                                    {outputCompose(g.buckets)}）
                                                </td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>

                            {/* 同一批行键的金额明细：逐项列出（模型间单价差异极大，
                                只有摊开才看得清"哪一项、哪个模型在烧钱"） */}
                            <table class="table table-xs mt-2 w-full whitespace-nowrap">
                                <thead>
                                    <tr>
                                        <th>人物</th>
                                        <th>模型</th>
                                        <th class="text-right">非缓存$</th>
                                        <th class="text-right">缓存读$</th>
                                        <th class="text-right">缓存写$</th>
                                        <th class="text-right">文本$</th>
                                        <th class="text-right">思考$</th>
                                        <th class="text-right">合计$</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={groupByAgent(steps())}>
                                        {(g) => (
                                            <tr>
                                                <td>{g.persona}</td>
                                                <td>{g.model}</td>
                                                <td class="text-right">{g.cost ? fmtCost(g.cost.noCache) : "n/a"}</td>
                                                <td class="text-right">{g.cost ? fmtCost(g.cost.cacheRead) : "n/a"}</td>
                                                <td class="text-right">
                                                    {g.cost?.cacheWrite == null ? "n/a" : fmtCost(g.cost.cacheWrite!)}
                                                </td>
                                                <td class="text-right">{g.cost ? fmtCost(g.cost.text) : "n/a"}</td>
                                                <td class="text-right">{g.cost ? fmtCost(g.cost.reasoning) : "n/a"}</td>
                                                <td class="text-right">{g.cost ? fmtCost(g.cost.total) : "n/a"}</td>
                                            </tr>
                                        )}
                                    </For>
                                    <tr>
                                        <td colspan="7" class="text-right opacity-70">
                                            会话合计（估算）
                                        </td>
                                        <td class="text-right">${fmtCost(totalCost())}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div class="mt-2 text-[10px] opacity-60">
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
                </div>
            </div>
        </Show>
    );
}

/**
 * JobMetricsView — 作业面板的「指标」页（##408 v2 观察面）。
 *
 * 用户口径：「我需要 v2 的 ui 来观察特性」。
 *
 * ── 三条刻意的克制 ──
 *   ① **不画时间序列**：`job.metrics` 是**拉模式**快照（`shared/metrics.ts`：没人问就不聚合、
 *      没有定时器、不入库）。所以这里画的是「此刻的累计值与分布」，不是折线图 ——
 *      画条随时间走的线要有历史，而历史正是 ##408 明确不做的东西。
 *      每次点「刷新」或切到本页 = 取一次新快照；底部明写这一点，免得被当成实时曲线。
 *   ② **不算派生指标**：面板只做**呈现**（分组 / 排序 / 求百分比），不在这里另立口径。
 *      派生指标一旦进了渲染层，CLI 与面板就会各说一套。
 *   ③ **维度缺失不静默**：`_none` 是「没有 origin 的 run」的合法维度（见 `metrics.ts`），
 *      照常显示，不藏起来 —— 藏起来等于让总数对不上。
 */

import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { METRIC_NAMES } from "../../shared/metric-names";
import type { MetricView, MetricsSnapshot, MetricPointView } from "../../shared/metric-names";
import { NO_TASK, bucketLabel, groupBy, histMerged, msText, num, pointsOf, taskRows } from "../lib/job-metrics";

const STATE_LABEL: Record<string, string> = {
    exited: "正常结束",
    killed: "被停止",
    failed: "失败",
    lost: "失联",
};

const OUTCOME_LABEL: Record<string, string> = {
    ok: "ok",
    fail: "fail",
    canceled: "用户取消",
    timeout: "超时",
};

export function JobMetricsView(props: { uri: string; all: boolean }) {
    const [snap, setSnap] = createSignal<MetricsSnapshot | null>(null);
    const [err, setErr] = createSignal<string | null>(null);
    const [busy, setBusy] = createSignal(false);

    const load = async (): Promise<void> => {
        setBusy(true);
        try {
            const r = await diyService.diy.job.metrics({});
            if (r.status !== "ok" || !("data" in r) || !r.data) {
                setErr((r as { msg?: string }).msg ?? "取指标失败");
                return;
            }
            setSnap(r.data as MetricsSnapshot);
            setErr(null);
        } catch (e) {
            setErr(`取指标失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    onMount(() => void load());

    /** 面板可见时每 5s 轻拉一次：真跑起来能看见数字在动（纯拉，没人看就不拉） */
    onMount(() => {
        const t = setInterval(() => void load(), 5_000);
        onCleanup(() => clearInterval(t));
    });

    const metricOf = (name: string): MetricView | null => snap()?.metrics.find((m) => m.name === name) ?? null;

    const running = () => pointsOf(metricOf(METRIC_NAMES.runRunning), props.uri, props.all);
    const started = () => pointsOf(metricOf(METRIC_NAMES.runStarted), props.uri, props.all);
    const settled = () => pointsOf(metricOf(METRIC_NAMES.runSettled), props.uri, props.all);
    const durations = () => pointsOf(metricOf(METRIC_NAMES.runDuration), props.uri, props.all);

    const sum = (pts: MetricPointView[]): number => pts.reduce((a, p) => a + num(p.value), 0);

    /** 三张卡的总数对不上时，这张表就是分诊台（口径全在纯函数里，组件不另立） */
    const byTask = () => taskRows({ running: running(), started: started(), settled: settled() });
    /** 一张分布图 = 把所有任务的点合并（`histMerged` 也负责：没数据就给 null） */
    const dist = () => histMerged(durations());

    return (
        <div class="flex h-full min-h-0 flex-col overflow-hidden text-body" data-job-metrics>
            {/* 头：快照时刻 + 刷新区 —— 「上次探测」永远是明确时刻 */}
            <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
                <span class="font-medium">指标</span>
                <span class="opacity-60" data-job-metrics-at>
                    {snap() ? `快照 ${new Date(snap()!.at).toLocaleTimeString()}` : "尚未取快照"}
                </span>
                <div class="flex-1" />
                <Show when={busy()}>
                    <span class="opacity-50">读取中…</span>
                </Show>
                <button class="btn btn-xs btn-ghost" data-job-metrics-refresh onClick={() => void load()}>
                    ↻ 刷新
                </button>
            </div>

            <Show when={err()}>{(m) => <div class="px-3 py-2 text-xs text-error">{m()}</div>}</Show>

            <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
                <Show when={snap()} fallback={<div class="py-6 text-center text-xs opacity-60">取指标中…</div>}>
                    {/* 空态：本进程还没跑过后台活 —— 说清楚"为什么是 0"，别只给一排 0 */}
                    <Show
                        when={sum(started()) > 0 || sum(running()) > 0}
                        fallback={
                            <div class="py-6 text-center text-xs opacity-60" data-job-metrics-empty>
                                这个进程还没有起过后台作业，所以累计值全是 0。
                                <div class="mt-1 opacity-70">
                                    指标是**进程内**累计 —— 重启即归零（OTel 的标准行为，抓取方认得）。
                                </div>
                            </div>
                        }
                    >
                        {/* ① 概览三张：在跑 / 启动 / 收口 */}
                        <div class="mb-3 grid grid-cols-3 gap-2">
                            <div class="rounded border border-base-content/10 bg-base-200/40 px-3 py-2">
                                <div class="text-xs opacity-60">现在在跑</div>
                                <div class="text-2xl font-semibold tabular-nums" data-job-metrics-running>
                                    {sum(running())}
                                </div>
                                <div class="text-xs opacity-60">gauge · job.run.running</div>
                            </div>
                            <div class="rounded border border-base-content/10 bg-base-200/40 px-3 py-2">
                                <div class="text-xs opacity-60">累计启动</div>
                                <div class="text-2xl font-semibold tabular-nums">{sum(started())}</div>
                                <div class="text-xs opacity-60">counter · started_total</div>
                            </div>
                            <div class="rounded border border-base-content/10 bg-base-200/40 px-3 py-2">
                                <div class="text-xs opacity-60">累计收口</div>
                                <div class="text-2xl font-semibold tabular-nums">{sum(settled())}</div>
                                <div class="text-xs opacity-60">
                                    counter · settled_total
                                    <Show when={sum(started()) !== sum(settled())}>
                                        <span
                                            class="ml-1 text-warning"
                                            data-tip="启动与收口不相等 = 还有 run 在跑（在跑数应等于差值）"
                                        >
                                            差 {sum(started()) - sum(settled())}
                                        </span>
                                    </Show>
                                </div>
                            </div>
                        </div>

                        {/* ② 终态分布：横条（占比 = 该终态 / 收口总数） */}
                        <div class="mb-3">
                            <div class="mb-1 text-xs font-medium opacity-80">终态分布</div>
                            <Show
                                when={sum(settled()) > 0}
                                fallback={<div class="text-xs opacity-50">还没有收口的 run。</div>}
                            >
                                <For each={groupBy(settled(), "state")}>
                                    {(g) => {
                                        const pct = () => (sum(settled()) === 0 ? 0 : (g.v / sum(settled())) * 100);
                                        return (
                                            <div
                                                class="mb-1 flex items-center gap-2 text-xs"
                                                data-job-metrics-state={g.k}
                                            >
                                                <span class="w-16 shrink-0 opacity-70">{STATE_LABEL[g.k] ?? g.k}</span>
                                                <div class="h-3 flex-1 overflow-hidden rounded bg-base-200">
                                                    <div
                                                        class="h-full bg-primary/70"
                                                        style={{ width: `${pct().toFixed(1)}%` }}
                                                    />
                                                </div>
                                                <span class="w-14 shrink-0 text-right tabular-nums opacity-80">
                                                    {g.v} · {pct().toFixed(0)}%
                                                </span>
                                            </div>
                                        );
                                    }}
                                </For>
                                {/* 结局细分（ok / fail / canceled / timeout）—— 与终态是两把尺子，分开显示 */}
                                <Show when={groupBy(settled(), "outcome").length > 0}>
                                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-70">
                                        <span class="opacity-70">结局：</span>
                                        <For each={groupBy(settled(), "outcome")}>
                                            {(g) => (
                                                <span data-job-metrics-outcome={g.k}>
                                                    {OUTCOME_LABEL[g.k] ?? g.k} {g.v}
                                                </span>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </Show>
                        </div>

                        {/* ③ 耗时分布：直方图桶（自画柱，零依赖） */}
                        <div class="mb-3">
                            <div class="mb-1 flex items-center gap-2 text-xs font-medium opacity-80">
                                耗时分布
                                <Show when={dist()}>
                                    {(h) => (
                                        <span class="font-normal opacity-60">
                                            n={h().count} · 平均 {msText(h().sum / h().count)} · 最短 {msText(h().min)}{" "}
                                            · 最长 {msText(h().max)}
                                        </span>
                                    )}
                                </Show>
                            </div>
                            <Show
                                when={dist()}
                                fallback={<div class="text-xs opacity-50">还没有带时长的收口记录。</div>}
                            >
                                {(h) => {
                                    const max = () => Math.max(1, ...h().counts);
                                    return (
                                        <div class="space-y-1" data-job-metrics-hist>
                                            <For each={h().counts}>
                                                {(c, i) => (
                                                    <div class="flex items-center gap-2 text-xs">
                                                        <span class="w-24 shrink-0 text-right font-mono opacity-70">
                                                            {bucketLabel(i(), h().boundaries)}
                                                        </span>
                                                        <div class="h-3 flex-1 overflow-hidden rounded bg-base-200">
                                                            <div
                                                                class={`h-full ${i() === h().counts.length - 1 ? "bg-warning/70" : "bg-info/70"}`}
                                                                style={{ width: `${((c / max()) * 100).toFixed(1)}%` }}
                                                            />
                                                        </div>
                                                        <span class="w-8 shrink-0 text-right tabular-nums opacity-80">
                                                            {c}
                                                        </span>
                                                    </div>
                                                )}
                                            </For>
                                            <div class="pt-1 text-[11px] opacity-50">
                                                最后一档 `&gt; 30m` 高亮：它装的是「超长活」，通常最该看。
                                            </div>
                                        </div>
                                    );
                                }}
                            </Show>
                        </div>

                        {/* ④ 按任务（「全部」视角才有意义，但本任务视角下也显示自己那一行） */}
                        <div>
                            <div class="mb-1 text-xs font-medium opacity-80">按任务</div>
                            <table class="w-full text-xs" data-job-metrics-by-task>
                                <thead class="opacity-60">
                                    <tr class="border-b text-left">
                                        <th class="py-0.5 font-normal">任务 / 维度</th>
                                        <th class="py-0.5 font-normal text-right">在跑</th>
                                        <th class="py-0.5 font-normal text-right">启动</th>
                                        <th class="py-0.5 font-normal text-right">收口</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={byTask()}>
                                        {(r) => (
                                            <tr class="border-b border-base-content/10" data-job-metrics-task={r.task}>
                                                <td class="py-0.5 font-mono">
                                                    {r.task === NO_TASK ? (
                                                        <span
                                                            class="opacity-60"
                                                            data-tip="没有 origin 的 run（将来的进程内任务 / 人为起的）"
                                                        >
                                                            （无来源）
                                                        </span>
                                                    ) : (
                                                        r.task
                                                    )}
                                                </td>
                                                <td class="py-0.5 text-right tabular-nums">{r.running}</td>
                                                <td class="py-0.5 text-right tabular-nums">{r.started}</td>
                                                <td class="py-0.5 text-right tabular-nums">{r.settled}</td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </div>
                    </Show>
                </Show>
            </div>

            {/* 底注：把「这是什么数据」一次说清 —— 观察面最怕被误读成时序 */}
            <div class="shrink-0 border-t px-3 py-1.5 text-[11px] leading-relaxed opacity-55">
                快照值，不是曲线：`job.metrics` 纯拉（没人问就不聚合、无定时器、不入库），本页每 5s 拉一次。
                累计值随进程重启归零；真源始终是活体表（`job.ps`），指标可随时丢光重算。
            </div>
        </div>
    );
}

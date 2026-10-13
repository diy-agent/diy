import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { JsonTree } from "./JsonTree";

/**
 * LLM 流量面板 —— 看「实际发出去的 HTTP 请求 / 响应」。
 *
 * 数据源是主进程的内存环形（core/llm-traffic.ts），**不落盘**：进程重启即空，
 * 这是「当下追因」而不是审计。常开保底环留住最近 N 条 —— 偶发 400 崩在你
 * 没录制的时候，事后点开还能看到那条的 request / response / trace_id。
 *
 * 归属来自请求头 `x-opencode-session` → 面板默认不过滤，列表自带 task/turn。
 */

type Snapshot = Awaited<ReturnType<typeof diyService.diy.llmTraffic.snapshot>>;
type Rec = Snapshot["records"][number];

const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

function statusCls(r: Rec): string {
    if (r.status === null) return "badge-error";
    if (r.status >= 500) return "badge-error";
    if (r.status >= 400) return "badge-warning";
    return "badge-success";
}

export function LlmTrafficPanel() {
    const [snap, setSnap] = createSignal<Snapshot | null>(null);
    const [sel, setSel] = createSignal<number | null>(null);
    const [tab, setTab] = createSignal<"req" | "res">("req");

    const refresh = async () => {
        const s = await diyService.diy.llmTraffic.snapshot({});
        setSnap(s);
        // 被环形挤掉的记录 → 详情自动退回列表
        if (sel() !== null && !s.records.some((r) => r.id === sel())) setSel(null);
    };
    onMount(() => {
        void refresh();
        const ac = new AbortController();
        void diyService.diy.llmTraffic
            .events({}, { signal: ac.signal })
            .then(async (stream) => {
                for await (const _ev of stream) void refresh();
            })
            .catch(() => {
                /* 断流即停（窗口关闭） */
            });
        onCleanup(() => ac.abort());
    });

    const records = () => (snap()?.records ?? []).slice().reverse(); // 最新在前
    const cur = () => records().find((r) => r.id === sel()) ?? null;

    const open = (r: Rec) => {
        setSel(r.id);
        setTab(r.status === null || r.status >= 400 ? "res" : "req");
    };
    const toggleRec = async () => {
        const s = await diyService.diy.llmTraffic.setRecording({ on: !snap()?.recording });
        setSnap(s);
    };
    const setCap = async (n: number) => {
        const s = await diyService.diy.llmTraffic.setCap({ n, which: "keepLast" });
        setSnap(s);
    };
    const clear = async () => {
        await diyService.diy.llmTraffic.clear({});
        setSel(null);
        await refresh();
    };

    return (
        <div class="flex flex-col gap-3">
            <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-display font-bold mr-auto">LLM 流量</h2>
                <span class={`badge ${snap()?.recording ? "badge-error" : "badge-ghost"}`}>
                    {snap()?.recording ? "● 录制中" : "保底环"}
                </span>
                <span class="text-body opacity-60">
                    共 {snap()?.total ?? 0} 条 / 上限 {snap()?.cap ?? 0}
                </span>
                <button class="btn btn-xs" onClick={toggleRec}>
                    {snap()?.recording ? "停止录制" : "开始录制"}
                </button>
                <select
                    class="select select-xs"
                    value={String(snap()?.keepLast ?? 20)}
                    onChange={(e) => void setCap(Number(e.currentTarget.value))}
                >
                    <For each={[20, 50, 100, 500]}>
                        {(n) => <option value={String(n)}>保留 {n} 条</option>}
                    </For>
                </select>
                <button class="btn btn-xs btn-ghost" onClick={() => void clear()}>
                    清空
                </button>
            </div>
            <p class="text-caption opacity-50">
                内存环形，不落盘（重启即空）。「保底环」常开留住最近若干条 —— 偶发的上游 400 崩在你没录制的时候，事后仍能点开看原样请求与响应。
            </p>

            <Show
                when={cur()}
                fallback={
                    <div class="flex flex-col gap-1">
                        <Show when={records().length === 0}>
                            <div class="text-body opacity-50 p-4 text-center">
                                暂无记录 —— 发起一次对话后这里会出现实际请求
                            </div>
                        </Show>
                        <For each={records()}>
                            {(r) => (
                                <button
                                    class="flex items-center gap-2 p-2 text-left border border-base-300 rounded hover:border-primary font-mono text-body"
                                    onClick={() => open(r)}
                                >
                                    <span class={`badge badge-sm ${statusCls(r)}`}>{r.status ?? "超时"}</span>
                                    <span class="opacity-60">{time(r.ts)}</span>
                                    <span class="truncate">{r.model.split("/").pop()}</span>
                                    <span class="opacity-60">a{r.attempt}</span>
                                    <span class="ml-auto opacity-60">{(r.ms / 1000).toFixed(2)}s</span>
                                    <Show when={r.traceId}>
                                        <span class="opacity-40 truncate max-w-32">{r.traceId}</span>
                                    </Show>
                                </button>
                            )}
                        </For>
                    </div>
                }
            >
                {(r) => (
                    <div class="flex flex-col gap-2 border border-base-300 rounded p-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <button class="btn btn-xs btn-ghost" onClick={() => setSel(null)}>
                                ← 列表
                            </button>
                            <span class={`badge badge-sm ${statusCls(r())}`}>{r().status ?? "无响应"}</span>
                            <span class="text-body opacity-60">{r().provider}</span>
                            <span class="text-body opacity-60">a{r().attempt}/1+{r().maxRetries}</span>
                            <span class="text-body opacity-60">{(r().ms / 1000).toFixed(2)}s</span>
                            <span class="text-caption opacity-50 truncate">{r().taskUri ?? "（非本进程）"}</span>
                        </div>
                        <Show when={r().traceId}>
                            <div class="text-body">
                                trace_id <code class="select-all">{r().traceId}</code>
                                <span class="opacity-50"> —— 上游追责凭据，可直接拿去找 provider 追</span>
                            </div>
                        </Show>
                        <Show when={r().err}>
                            <div class="text-body text-error">⚠ {r().err}</div>
                        </Show>
                        <div role="tablist" class="tabs tabs-boxed tabs-xs w-fit">
                            <button
                                role="tab"
                                class={`tab ${tab() === "req" ? "tab-active" : ""}`}
                                onClick={() => setTab("req")}
                            >
                                请求
                            </button>
                            <button
                                role="tab"
                                class={`tab ${tab() === "res" ? "tab-active" : ""}`}
                                onClick={() => setTab("res")}
                            >
                                响应
                            </button>
                        </div>
                        <div class="max-h-96 overflow-auto bg-base-200 rounded p-2">
                            <Show when={tab() === "req"} fallback={<JsonTree data={{ resHeaders: r().resHeaders, resBody: r().resBody }} />}>
                                <JsonTree
                                    data={{
                                        url: r().url,
                                        method: r().method,
                                        headers: r().reqHeaders,
                                        body: r().reqBody,
                                    }}
                                />
                            </Show>
                        </div>
                    </div>
                )}
            </Show>
        </div>
    );
}

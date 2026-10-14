import { createSignal, createEffect, createMemo, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { JsonViewer } from "./JsonViewer";

/**
 * 流量视图 —— 看「实际发出去的 HTTP 请求 / 响应」。
 *
 * 数据来自主进程（core/traffic.ts）：只在内存里留最近若干条，进程重启就没了 ——
 * 这是「当下排查」用的，不是审计日志。常开时也始终留着最近若干条，所以偶发的上游
 * 400 就算崩在你没注意的时候，事后点开还能看到那一条的请求 / 响应 / trace_id。
 *
 * 本文件导出 `TrafficView`：纯视图，撑满父容器（列表 ⇄ 详情）。流量页与聊天侧抽屉共用同一份。
 */

type Snapshot = Awaited<ReturnType<typeof diyService.diy.traffic.snapshot>>;
type Rec = Snapshot["records"][number];

const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

function statusText(r: Rec): string {
    if (r.status !== null) return String(r.status);
    return r.err ? "网络错" : "超时";
}
function statusCls(r: Rec): string {
    if (r.status === null) return "badge-error";
    if (r.status >= 500) return "badge-error";
    if (r.status >= 400) return "badge-warning";
    return "badge-success";
}
const isFail = (r: Rec) => (r.status != null && r.status >= 400) || !!r.err;

function kindLabel(k: Rec["kind"]): string {
    if (k === "llm") return "LLM";
    if (k === "probe") return "配置探测";
    return "其它";
}

/** 状态筛选：全部 / 成功 / 4xx / 5xx / 失败（网络错/超时） */
type StatusFilter = "all" | "ok" | "4xx" | "5xx" | "err";
function matchStatus(r: Rec, f: StatusFilter): boolean {
    if (f === "all") return true;
    if (f === "ok") return r.status != null && r.status < 400;
    if (f === "4xx") return r.status != null && r.status >= 400 && r.status < 500;
    if (f === "5xx") return r.status != null && r.status >= 500;
    return r.status === null;
}

/** 「24/500行」—— 点数字可改成上限（输入框），悬停提示当前/上限 */
function CapLabel(props: { total: number; cap: number; onSetCap: (n: number) => void }) {
    const [editing, setEditing] = createSignal(false);
    const [draft, setDraft] = createSignal("");
    const commit = () => {
        const n = Number(draft());
        if (Number.isFinite(n) && n > 0) props.onSetCap(n);
        setEditing(false);
    };
    return (
        <span
            class="inline-flex items-center gap-0.5 text-body opacity-70"
            title={`当前记录行数 ${props.total} / 最大记录行数 ${props.cap}`}
        >
            <span>{props.total}/</span>
            <Show
                when={editing()}
                fallback={
                    <button
                        class="underline decoration-dotted hover:text-primary cursor-pointer"
                        onClick={() => {
                            setDraft(String(props.cap));
                            setEditing(true);
                        }}
                    >
                        {props.cap}
                    </button>
                }
            >
                <input
                    class="input input-bordered input-xs w-16"
                    autofocus
                    value={draft()}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setEditing(false);
                    }}
                />
            </Show>
            <span>行</span>
        </span>
    );
}

export function TrafficView(props: {
    /** 打开时要定位的记录（优先 id，其次 trace_id；都没有则定位最近一次失败） */
    focus?: { traceId?: string | null; reqId?: number | null } | null;
    /** focus 消费后回调（清掉，避免下次重开误定位） */
    onFocusConsumed?: () => void;
    /** 是否显示内置大标题 + 说明（页面显示；抽屉有自己的标题栏，隐藏） */
    showIntro?: boolean;
}) {
    const [snap, setSnap] = createSignal<Snapshot | null>(null);
    const [sel, setSel] = createSignal<number | null>(null);
    const [tab, setTab] = createSignal<"req" | "res">("req");
    // 筛选
    const [qUrl, setQUrl] = createSignal("");
    const [fStatus, setFStatus] = createSignal<StatusFilter>("all");
    const [fMethod, setFMethod] = createSignal("all");

    const refresh = async () => {
        const s = await diyService.diy.traffic.snapshot({});
        setSnap(s);
        if (sel() !== null && !s.records.some((r) => r.id === sel())) setSel(null);
    };
    onMount(() => {
        void refresh();
        const ac = new AbortController();
        void diyService.diy.traffic
            .events({}, { signal: ac.signal })
            .then(async (stream) => {
                for await (const _ev of stream) void refresh();
            })
            .catch(() => {
                /* 断流即停（窗口关闭） */
            });
        onCleanup(() => ac.abort());
    });

    /** 过滤后、最新在前 */
    const records = createMemo(() => {
        const q = qUrl().trim().toLowerCase();
        const m = fMethod();
        const f = fStatus();
        return (snap()?.records ?? [])
            .filter((r) => (q ? r.url.toLowerCase().includes(q) : true))
            .filter((r) => (m === "all" ? true : r.method === m))
            .filter((r) => matchStatus(r, f))
            .slice()
            .reverse();
    });
    const cur = () => (snap()?.records ?? []).find((r) => r.id === sel()) ?? null;
    const methods = createMemo(() => Array.from(new Set((snap()?.records ?? []).map((r) => r.method))).sort());

    // 定位：优先 id → trace_id → 最近一次失败
    createEffect(() => {
        const f = props.focus;
        if (!f) return;
        const all = snap()?.records ?? [];
        if (all.length === 0) return;
        let r = f.reqId != null ? all.find((x) => x.id === f.reqId) : undefined;
        if (!r && f.traceId) r = all.find((x) => x.traceId === f.traceId);
        if (!r) {
            const fails = all.filter(isFail);
            r = fails[fails.length - 1];
        }
        if (r) {
            setSel(r.id);
            setTab(isFail(r) ? "res" : "req");
            props.onFocusConsumed?.();
        }
    });

    const open = (r: Rec) => {
        setSel(r.id);
        setTab(isFail(r) ? "res" : "req");
    };
    const toggleRec = async () => {
        const s = await diyService.diy.traffic.setRecording({ on: !snap()?.recording });
        setSnap(s);
    };
    const setCap = async (n: number) => {
        // 改的是「当前生效」的那个上限：录制模式改 recCap，普通模式改 keepLast
        const s = await diyService.diy.traffic.setCap({ n, which: snap()?.recording ? "recCap" : "keepLast" });
        setSnap(s);
    };
    const clear = async () => {
        await diyService.diy.traffic.clear({});
        setSel(null);
        await refresh();
    };

    return (
        <div class="flex flex-col gap-3 h-full min-h-0">
            <div class="flex items-center gap-2 flex-wrap shrink-0">
                <Show when={props.showIntro !== false}>
                    <h2 class="text-display font-bold mr-auto">流量</h2>
                </Show>
                <span
                    class={`badge ${snap()?.recording ? "badge-error" : "badge-ghost"}`}
                    title={snap()?.recording ? "正在录制：上限放大且不截断内容" : "未录制：只留最近若干条、内容过长会截断"}
                >
                    {snap()?.recording ? "● 录制中" : "● 常开"}
                </span>
                <CapLabel total={snap()?.total ?? 0} cap={snap()?.cap ?? 0} onSetCap={(n) => void setCap(n)} />
                <button class="btn btn-xs" onClick={toggleRec}>
                    {snap()?.recording ? "停止录制" : "开始录制"}
                </button>
                <button class="btn btn-xs btn-ghost" onClick={() => void clear()}>
                    清空
                </button>
            </div>
            <Show when={props.showIntro !== false}>
                <p class="text-caption opacity-50 shrink-0">
                    这里显示应用实际发出去的 HTTP 请求与收到的响应，只保留最近若干条（进程重启就没了）。
                </p>
            </Show>

            <Show
                when={cur()}
                fallback={
                    <div class="flex flex-col flex-1 min-h-0 gap-2">
                        {/* 查询条：按地址 / 状态 / 方法过滤 */}
                        <div class="flex items-center gap-2 flex-wrap shrink-0">
                            <input
                                class="input input-bordered input-xs w-64"
                                placeholder="🔍 按地址过滤…"
                                value={qUrl()}
                                onInput={(e) => setQUrl(e.currentTarget.value)}
                            />
                            <select
                                class="select select-xs"
                                value={fStatus()}
                                onChange={(e) => setFStatus(e.currentTarget.value as StatusFilter)}
                            >
                                <option value="all">全部状态</option>
                                <option value="ok">成功（2xx/3xx）</option>
                                <option value="4xx">4xx</option>
                                <option value="5xx">5xx</option>
                                <option value="err">失败（网络错/超时）</option>
                            </select>
                            <select
                                class="select select-xs"
                                value={fMethod()}
                                onChange={(e) => setFMethod(e.currentTarget.value)}
                            >
                                <option value="all">全部方法</option>
                                <For each={methods()}>{(m) => <option value={m}>{m}</option>}</For>
                            </select>
                            <span class="text-caption opacity-50">
                                {records().length} / {snap()?.total ?? 0} 条
                            </span>
                        </div>
                        <div class="flex-1 min-h-0 overflow-auto border border-base-300 rounded">
                            <table class="table table-xs table-pin-rows w-full">
                                <thead>
                                    <tr>
                                        <th class="w-16">状态</th>
                                        <th class="w-16">方法</th>
                                        <th>名称</th>
                                        <th class="w-28">来源</th>
                                        <th class="w-14 text-right">尝试</th>
                                        <th class="w-20 text-right">耗时</th>
                                        <th class="w-24">时间</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <Show when={records().length === 0}>
                                        <tr>
                                            <td colspan="7" class="text-center opacity-50 py-6">
                                                {snap()?.total ? "没有符合筛选条件的记录" : "暂无记录 —— 发起一次请求后这里会出现"}
                                            </td>
                                        </tr>
                                    </Show>
                                    <For each={records()}>
                                        {(r) => (
                                            <tr
                                                class="cursor-pointer hover:bg-base-200"
                                                onClick={() => open(r)}
                                                title={r.url}
                                            >
                                                <td>
                                                    <span class={`badge badge-sm ${statusCls(r)}`}>{statusText(r)}</span>
                                                </td>
                                                <td class="font-mono">{r.method}</td>
                                                <td class="font-mono truncate max-w-0">
                                                    <span class="opacity-60">{r.host}</span>
                                                    {r.path}
                                                </td>
                                                <td class="truncate">
                                                    <span class="badge badge-ghost badge-sm">{kindLabel(r.kind)}</span>
                                                    <Show when={r.model}>
                                                        <span class="ml-1 opacity-60">{r.model.split("/").pop()}</span>
                                                    </Show>
                                                </td>
                                                <td class="text-right">{r.kind === "llm" ? `a${r.attempt}` : "—"}</td>
                                                <td class="text-right">{(r.ms / 1000).toFixed(2)}s</td>
                                                <td class="opacity-60">{time(r.ts)}</td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </div>
                    </div>
                }
            >
                {(r) => (
                    <div class="flex flex-col gap-2 border border-base-300 rounded p-2 flex-1 min-h-0">
                        <div class="flex items-center gap-2 flex-wrap shrink-0">
                            <button class="btn btn-xs btn-ghost" onClick={() => setSel(null)}>
                                ← 列表
                            </button>
                            <span class={`badge badge-sm ${statusCls(r())}`}>{statusText(r())}</span>
                            <span class="text-body opacity-60">{kindLabel(r().kind)}</span>
                            <Show when={r().model}>
                                <span class="text-body opacity-60">{r().model}</span>
                            </Show>
                            <Show when={r().kind === "llm"}>
                                <span class="text-body opacity-60">第 {r().attempt} 次</span>
                            </Show>
                            <span class="text-body opacity-60">{(r().ms / 1000).toFixed(2)}s</span>
                            <span class="text-caption opacity-50 truncate">{r().taskUri ?? "（无任务归属）"}</span>
                        </div>
                        <div class="text-body font-mono break-all shrink-0">
                            <span class="opacity-60">{r().method}</span> {r().url}
                        </div>
                        <Show when={r().traceId}>
                            <div class="text-body shrink-0">
                                trace_id <code class="select-all">{r().traceId}</code>
                                <span class="opacity-50"> —— 上游追责凭据，可直接拿去找 provider 追</span>
                            </div>
                        </Show>
                        <Show when={r().err}>
                            <div class="text-body text-error shrink-0">⚠ {r().err}</div>
                        </Show>
                        <div role="tablist" class="tabs tabs-boxed tabs-xs w-fit shrink-0">
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
                        <div class="flex-1 min-h-0 min-w-0">
                            <Show
                                when={tab() === "req"}
                                fallback={
                                    <JsonViewer
                                        data={{ status: r().status, headers: r().resHeaders, body: r().resBody }}
                                    />
                                }
                            >
                                <JsonViewer
                                    data={{
                                        url: r().url,
                                        method: r().method,
                                        headers: r().reqHeaders,
                                        body: r().reqBody ?? (r().method === "GET" ? "（GET 请求无 body）" : null),
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

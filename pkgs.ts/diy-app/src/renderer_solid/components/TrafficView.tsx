import { createSignal, createEffect, createMemo, onCleanup, onMount, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { JsonViewer } from "./JsonViewer";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 流量视图 —— 看「实际发出去的 HTTP 请求 / 响应」。
 *
 * 数据来自磁盘日志（主进程 `core/traffic-log.ts` 写的 `log/network/YYYY-MM-DD.jsonl`）：
 * 一天一个文件，按 日期 + 全文关键词 + 状态 + 方法 查询，新的在前。为什么直接查文件而不是只看内存：
 * 内存只留最近若干条（进程重启就空），而「偶发 400」这类问题事后才想回看，必须能翻历史。
 *
 * 主进程也在内存里留了最近若干条（用于聊天侧错误块一键深链），本视图的头部状态和深链 id 从那里取。
 *
 * 本文件导出 `TrafficView`：纯视图，撑满父容器（列表 ⇄ 详情）。流量页与聊天侧抽屉共用同一份。
 */

type Snapshot = Awaited<ReturnType<typeof diyService.diy.traffic.snapshot>>;
type Rec = Snapshot["records"][number];

const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

/** 本地日期 YYYY-MM-DD（与落盘文件名一致） */
function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

type BodyCapture = NonNullable<Rec["reqBody"]>;

/**
 * 把「首尾法保留的正文」还原成可展示的值：未截断且能解析成 JSON → 结构；否则 → 文本。
 * 被截断时，中间省略的部分用 `<…>` 包一句说明插在头尾之间，一眼能看出这里断过。
 */
function bodyValue(c: BodyCapture | null, note: string | null): unknown {
    if (!c) return note ?? "（无正文）";
    if (!c.truncated) {
        try {
            return JSON.parse(c.head);
        } catch {
            return c.head;
        }
    }
    const omitted = c.totalBytes - c.headBytes - c.tailBytes;
    return `${c.head}\n<中间省略 ${omitted} 字节（正文共 ${c.totalBytes} 字节）>\n${c.tail}`;
}

/**
 * 「存储在 <绝对路径>:<行>」—— 把这条记录定位到磁盘上的具体一处。
 * 路径是超链接：点它弹出小菜单，可选「在文件管理器中显示」（打开所在目录并选中该文件）。
 * 位置格式是通用约定 `<绝对路径>:<行>`（见 ~/AGENTS.md）。
 */
function StoredAt(props: { loc: Rec["log"] }) {
    const [menu, setMenu] = createSignal(false);
    const [pos, setPos] = createSignal({ x: 0, y: 0 });
    const [msg, setMsg] = createSignal<string | null>(null);
    let linkRef: HTMLAnchorElement | undefined;

    const openMenu = () => {
        const r = linkRef?.getBoundingClientRect();
        if (r) setPos({ x: r.left, y: r.bottom + 4 });
        setMenu(true);
    };
    const reveal = async () => {
        setMenu(false);
        const loc = props.loc;
        if (!loc) return;
        const res = await diyService.diy.traffic.revealLog({ file: loc.file });
        setMsg(res.ok ? null : (res.message ?? "打开失败"));
    };
    // 点别处关掉小菜单
    onMount(() => {
        const onDoc = (e: MouseEvent) => {
            if (linkRef && e.target instanceof Node && linkRef.contains(e.target)) return;
            setMenu(false);
        };
        document.addEventListener("click", onDoc);
        onCleanup(() => document.removeEventListener("click", onDoc));
    });

    return (
        <Show when={props.loc}>
            {(loc) => (
                <div class="flex items-center gap-2 text-caption shrink-0 flex-wrap">
                    <span class="opacity-50">存储在</span>
                    <a
                        ref={(el) => (linkRef = el)}
                        class="link link-hover cursor-pointer font-mono opacity-80 break-all"
                        title={`${loc().abs}:${loc().line}\n（等价写法：${loc().abs}#${loc().line}）`}
                        onClick={(e) => {
                            e.preventDefault();
                            openMenu();
                        }}
                    >
                        {loc().abs}:{loc().line}
                    </a>
                    <Show when={menu()}>
                        <div
                            class="fixed z-[60] bg-base-100 border border-base-300 rounded shadow-lg py-1"
                            style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <button class="block w-full text-left px-3 py-1 hover:bg-base-200 text-body" onClick={() => void reveal()}>
                                在文件管理器中显示
                            </button>
                        </div>
                    </Show>
                    <Show when={msg()}>
                        <span class="text-warning">{msg()}</span>
                    </Show>
                </div>
            )}
        </Show>
    );
}

function kindLabel(k: Rec["kind"]): string {
    if (k === "llm") return "LLM";
    if (k === "probe") return "配置探测";
    return "其它";
}

/** 状态筛选：全部 / 成功 / 4xx / 5xx / 失败（网络错/超时） */
type StatusFilter = "all" | "ok" | "4xx" | "5xx" | "err";
const STATUS_OPTIONS: Array<{ v: StatusFilter; label: string }> = [
    { v: "all", label: "全部状态" },
    { v: "ok", label: "成功（2xx/3xx）" },
    { v: "4xx", label: "4xx" },
    { v: "5xx", label: "5xx" },
    { v: "err", label: "失败（网络错/超时）" },
];

/** 「24/500行」—— 点数字可改成上限（输入框），悬停提示当前/上限（只管内存里留多少条） */
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
    const [rows, setRows] = createSignal<Rec[]>([]);
    const [loading, setLoading] = createSignal(false);
    const [stats, setStats] = createSignal<{ scanned: number; ms: number; truncated: boolean } | null>(null);
    const [sel, setSel] = createSignal<number | null>(null);
    const [tab, setTab] = createSignal<"req" | "res">("req");
    // 筛选
    const [qText, setQText] = createSignal("");
    const [fStatus, setFStatus] = createSignal<StatusFilter>("all");
    const [fMethod, setFMethod] = createSignal("all");
    const [fDate, setFDate] = createSignal<string>(todayStr());
    const [dates, setDates] = createSignal<string[]>([]);
    const [confirmFull, setConfirmFull] = createSignal(false);

    const loadSnapshot = async () => {
        setSnap(await diyService.diy.traffic.snapshot({}));
    };
    const loadDates = async () => {
        const r = await diyService.diy.traffic.logFiles({});
        setDates(r.dates);
    };

    /** 按当前筛选查磁盘日志 */
    const runQuery = async () => {
        setLoading(true);
        try {
            const res = await diyService.diy.traffic.query({
                text: qText(),
                status: fStatus(),
                method: fMethod(),
                date: fDate(),
                limit: 1000,
            });
            setRows(res.records as unknown as Rec[]);
            setStats({ scanned: res.scanned, ms: res.ms, truncated: res.truncated });
            if (sel() !== null && !res.records.some((r) => (r as { id: number }).id === sel())) setSel(null);
        } finally {
            setLoading(false);
        }
    };

    // 输入防抖：敲字时别每一下都扫盘
    let qTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleQuery = (delay = 0) => {
        if (qTimer) clearTimeout(qTimer);
        qTimer = setTimeout(() => void runQuery(), delay);
    };

    onMount(() => {
        void loadSnapshot();
        void loadDates();
        void runQuery();
        const ac = new AbortController();
        void diyService.diy.traffic
            .events({}, { signal: ac.signal })
            .then(async (stream) => {
                // 有新记录 / 开关变更 → 刷新状态，并（防抖）重查一次今日数据
                for await (const _ev of stream) {
                    void loadSnapshot();
                    void loadDates();
                    scheduleQuery(300);
                }
            })
            .catch(() => {
                /* 断流即停（窗口关闭） */
            });
        onCleanup(() => {
            ac.abort();
            if (qTimer) clearTimeout(qTimer);
        });
    });

    const methods = createMemo(() => Array.from(new Set(rows().map((r) => r.method))).sort());
    const dateOptions = createMemo(() => {
        const t = todayStr();
        const rest = dates().filter((d) => d !== t);
        return { today: t, rest };
    });
    const cur = () => rows().find((r) => r.id === sel()) ?? null;

    // 定位：优先 id → trace_id → 最近一次失败（在当前查询结果里找）
    createEffect(() => {
        const f = props.focus;
        if (!f) return;
        const all = rows();
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
    const doSetFullCapture = async (on: boolean) => {
        const s = await diyService.diy.traffic.setFullCapture({ on });
        setSnap(s);
    };
    const onToggleFullCapture = () => {
        if (snap()?.fullCapture) void doSetFullCapture(false);
        else setConfirmFull(true); // 开启是重操作：先弹窗说清楚
    };
    const setCap = async (n: number) => {
        const s = await diyService.diy.traffic.setCap({ n });
        setSnap(s);
    };
    const clear = async () => {
        await diyService.diy.traffic.clear({});
        setSel(null);
        await loadSnapshot();
    };

    return (
        <div class="flex flex-col gap-3 h-full min-h-0">
            <Show when={confirmFull()}>
                <ConfirmDialog
                    title="记录完整请求内容"
                    message="开启后，每个请求/响应正文都会完整写入磁盘日志，不再只留首尾一段。长时间运行可能占用大量磁盘空间。本开关只在本次运行内有效，应用退出后自动关闭。确定开启吗？"
                    confirmLabel="开启"
                    onCancel={() => setConfirmFull(false)}
                    onConfirm={() => {
                        setConfirmFull(false);
                        void doSetFullCapture(true);
                    }}
                />
            </Show>
            <div class="flex items-center gap-2 flex-wrap shrink-0">
                <Show when={props.showIntro !== false}>
                    <h2 class="text-display font-bold mr-auto">流量</h2>
                </Show>
                <CapLabel total={snap()?.total ?? 0} cap={snap()?.cap ?? 0} onSetCap={(n) => void setCap(n)} />
                <button
                    class={`btn btn-xs ${snap()?.fullCapture ? "btn-error" : ""}`}
                    onClick={onToggleFullCapture}
                    title={
                        snap()?.fullCapture
                            ? "正在完整记录：正文不再截断。点击关闭（关闭后恢复只留首尾一段）"
                            : "默认只保留正文开头 8K + 结尾 16K（中间省略）。开启后正文完整记录、不截断；会占用较多磁盘，应用退出时自动关闭。"
                    }
                >
                    {snap()?.fullCapture ? "● 完整记录中" : "记录完整请求内容"}
                </button>
                <button class="btn btn-xs btn-ghost" onClick={() => void clear()}>
                    清空
                </button>
            </div>
            <Show when={props.showIntro !== false}>
                <p class="text-caption opacity-50 shrink-0">
                    这里显示应用实际发出去的 HTTP 请求与收到的响应。记录一直开着，逐条写进磁盘日志（按天切文件），可用日期 + 关键词翻查历史。
                    超长正文默认只留首尾一段，需要完整时打开「记录完整请求内容」。
                </p>
            </Show>

            <Show
                when={cur()}
                fallback={
                    <div class="flex flex-col flex-1 min-h-0 gap-2">
                        {/* 查询条：全文关键词 / 日期 / 状态 / 方法 */}
                        <div class="flex items-center gap-2 flex-wrap shrink-0">
                            <input
                                class="input input-bordered input-xs w-64"
                                placeholder="🔍 全文搜索（地址 / 状态 / 模型 / 正文…）"
                                value={qText()}
                                onInput={(e) => {
                                    setQText(e.currentTarget.value);
                                    scheduleQuery(300);
                                }}
                            />
                            <select
                                class="select select-xs"
                                value={fDate()}
                                onChange={(e) => {
                                    setFDate(e.currentTarget.value);
                                    scheduleQuery();
                                }}
                                title="数据按天存放；默认只看当天，可切到其它日期或全部"
                            >
                                <option value={dateOptions().today}>{dateOptions().today}（今日）</option>
                                <For each={dateOptions().rest}>{(d) => <option value={d}>{d}</option>}</For>
                                <option value="all">全部日期</option>
                            </select>
                            <select
                                class="select select-xs"
                                value={fStatus()}
                                onChange={(e) => {
                                    setFStatus(e.currentTarget.value as StatusFilter);
                                    scheduleQuery();
                                }}
                            >
                                <For each={STATUS_OPTIONS}>{(o) => <option value={o.v}>{o.label}</option>}</For>
                            </select>
                            <select
                                class="select select-xs"
                                value={fMethod()}
                                onChange={(e) => {
                                    setFMethod(e.currentTarget.value);
                                    scheduleQuery();
                                }}
                            >
                                <option value="all">全部方法</option>
                                <For each={methods()}>{(m) => <option value={m}>{m}</option>}</For>
                            </select>
                            <span class="text-caption opacity-50">
                                <Show when={loading()} fallback={<span>{rows().length} 条</span>}>
                                    <span class="animate-pulse">查询中…</span>
                                </Show>
                            </span>
                            <Show when={!loading() && stats()}>
                                {(s) => (
                                    <span class="text-caption opacity-40">
                                        扫 {s().scanned} 行 · {s().ms}ms{s().truncated ? " · 已截断，请缩小范围" : ""}
                                    </span>
                                )}
                            </Show>
                        </div>
                        <div class="flex-1 min-h-0 overflow-auto border border-base-300 rounded">
                            <table class="table table-xs table-pin-rows w-full">
                                <thead>
                                    <tr>
                                        <th class="w-16">状态</th>
                                        <th class="w-16">方法</th>
                                        <th>地址</th>
                                        <th class="w-32">来源</th>
                                        <th class="w-14 text-right">尝试</th>
                                        <th class="w-20 text-right">耗时</th>
                                        <th class="w-20">时间</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <Show when={rows().length === 0}>
                                        <tr>
                                            <td colspan="7" class="text-center opacity-50 py-6">
                                                {loading() ? "查询中…" : "没有符合筛选条件的记录"}
                                            </td>
                                        </tr>
                                    </Show>
                                    <For each={rows()}>
                                        {(r) => (
                                            <tr class="cursor-pointer hover:bg-base-200" onClick={() => open(r)} title={r.url}>
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
                        <StoredAt loc={r().log} />
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
                                        data={{
                                            status: r().status,
                                            headers: r().resHeaders,
                                            body: bodyValue(r().resBody, r().resNote),
                                        }}
                                    />
                                }
                            >
                                <JsonViewer
                                    data={{
                                        url: r().url,
                                        method: r().method,
                                        headers: r().reqHeaders,
                                        body: bodyValue(r().reqBody, r().method === "GET" ? "（GET 请求无 body）" : null),
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

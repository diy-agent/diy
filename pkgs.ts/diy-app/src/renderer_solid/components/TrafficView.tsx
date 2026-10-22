import { createSignal, createEffect, createMemo, onCleanup, onMount, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { diyService } from "../lib/rpc";
import { JsonViewer } from "./JsonViewer";
import { findStore } from "../store/findStore";
import type { TrafficFocus } from "../store/trafficStore";
import { fmtBytes } from "../lib/bytes";
import { TrafficLogCleanButton } from "./TrafficLogCleanup";

/**
 * 流量视图 —— 看「实际发出去的 HTTP 请求 / 响应」。
 *
 * 数据来自磁盘日志（主进程 `core/traffic-log.ts` 写的 `log/network/YYYY-MM-DD.jsonl`）：
 * 一天一个文件，按 日期 + 全文关键词 + 状态 + 方法 查询，新的在前。为什么直接查文件而不是只看内存：
 * 内存只留最近若干条（进程重启就空），而「偶发 400」这类问题事后才想回看，必须能翻历史。
 *
 * 本文件导出**可复用的三件套**（同一份状态，两种摆法）：
 *   · `createTrafficState()` —— 页面/抽屉共用的状态与动作（筛选 / 查询 / 选中 / 排序列配置）
 *   · `TrafficList` / `TrafficDetail` —— 「基本信息」「请求 / 响应编辑器」两块，**各自可放 area**
 *   · `TrafficView` —— 抽屉形态：单人视图、列表 ⇄ 详情原地切换（贴着对话查一条）
 * 流量**页**按 viewset 摆（左 = 基本信息、右 = 请求响应编辑器），走 ViewGrid（见 TrafficPage）。
 */

type Snapshot = Awaited<ReturnType<typeof diyService.diy.traffic.snapshot>>;
type Rec = Snapshot["records"][number];

/** 完整日期时间（本地时区 = 当前系统时区），如 `2026-10-14 13:47:58` */
const time = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

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

/**
 * 选中 / 定位用的稳定唯一键。
 *
 * 为什么不用 `id`：`id` 是**每次进程运行内**自增的（重启就从 1 重来），而流量列表查的是**磁盘日志**
 * —— 跨进程、跨天都在，于是不同运行写下的记录会拿到相同 `id`，按 id 定位会打开错的那条。
 * 落盘位置（文件 + 行号）是 append-only、天然唯一且递增的，正好当身份键，也顺带就是「实际顺序」。
 */
const keyOf = (r: Rec): string => (r.log ? `${r.log.file}#${r.log.line}` : `id:${r.id}:${r.ts}`);

/** 响应内容类型（对齐 devtools 的 Type 列）：取 content-type 主类型，缺省看来源 */
function mimeType(r: Rec): string {
    const ct = r.resHeaders["content-type"];
    if (ct) {
        const main = ct.split(";")[0]!.trim().toLowerCase();
        if (main === "application/json") return "json";
        if (main === "text/event-stream") return "events";
        if (main.startsWith("text/")) return main.slice(5);
        return main;
    }
    return r.kind === "llm" ? "llm" : "—";
}

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

/** 表格列（对齐 Chrome devtools / Network 的常见字段；可配置显隐） */
type ColKey = "seqno" | "status" | "method" | "name" | "type" | "size" | "duration" | "time" | "source" | "attempt";
interface ColDef {
    key: ColKey;
    label: string;
    width?: string;
    align?: "right";
    tip?: string;
    /** 默认显示（重要的那几个）；其余默认隐藏，用户可在「列」里打开 */
    on: boolean;
}
const COLUMNS: ColDef[] = [
    { key: "seqno", label: "序号", width: "w-14", align: "right", on: true, tip: "落盘追加顺序（当天日志文件内的行号，按写入先后）" },
    { key: "status", label: "状态", width: "w-16", on: true },
    { key: "method", label: "方法", width: "w-16", on: true },
    { key: "name", label: "名称", on: true, tip: "主机 + 路径（对齐 devtools 的 Name 列）" },
    { key: "type", label: "类型", width: "w-20", on: true, tip: "响应内容类型（对齐 devtools 的 Type 列）" },
    { key: "size", label: "大小", width: "w-20", align: "right", on: true, tip: "请求体 + 响应体字节数" },
    { key: "duration", label: "耗时", width: "w-20", align: "right", on: true },
    { key: "time", label: "时间", width: "w-40", on: true, tip: "完整日期时间（本地时区）" },
    { key: "source", label: "来源", width: "w-32", on: true, tip: "谁发起的（LLM 对话 / 模型配置探测 / 其它）" },
    {
        key: "attempt",
        label: "步/次",
        width: "w-16",
        align: "right",
        on: false,
        tip: "步.次 = 本轮第几个逻辑步 · 该步第几次 HTTP 往返（2 起即重试）；没有步号的老记录只显示往返序号",
    },
];

/** 单元格取值（也用于排序） */
function cellValue(r: Rec, key: ColKey): { text: string; num?: number } {
    switch (key) {
        case "seqno":
            return { text: r.log ? String(r.log.line) : "—", num: r.log?.line ?? 0 };
        case "status":
            return { text: statusText(r), num: r.status ?? -1 };
        case "method":
            return { text: r.method };
        case "name":
            return { text: `${r.host}${r.path}` };
        case "type":
            return { text: mimeType(r) };
        case "size":
            return { text: fmtBytes(r.reqBytes + r.resBytes), num: r.reqBytes + r.resBytes };
        case "duration":
            return { text: `${(r.ms / 1000).toFixed(2)}s`, num: r.ms };
        case "time":
            return { text: time(r.ts), num: r.ts };
        case "source":
            return { text: kindLabel(r.kind) + (r.model ? ` ${r.model.split("/").pop()}` : "") };
        case "attempt": {
            if (r.kind !== "llm") return { text: "—", num: 0 };
            // 步号 + 该步内第几次（##409）：这是判断「这步重试了几次」的读法
            if (typeof r.stepSeq === "number" && typeof r.attemptInStep === "number") {
                return { text: `${r.stepSeq}.${r.attemptInStep}`, num: r.attempt };
            }
            return { text: String(r.attempt), num: r.attempt };
        }
    }
}

/** 惰性加载：首屏显示多少条，滚动到底再追加多少 */
const PAGE_SIZE = 100;

/**
 * 流量视图的**状态与动作**（页面 / 抽屉共用同一套）。
 *
 * 为什么抽成函数而不是 store 单例：抽屉与页面可以**各持一份**（互不抢筛选与选中），
 * 只要调用两次 `createTrafficState()` 即可；而「同一份状态喂两个 view」在本函数外组合。
 */
export function createTrafficState(opts: {
    /** 打开时要定位的记录（优先 id，其次 trace_id；都没有则定位最近一次失败） */
    focus?: Accessor<TrafficFocus | null>;
    /** focus 消费后回调（清掉，避免下次重开误定位） */
    onFocusConsumed?: () => void;
} = {}) {
    const [snap, setSnap] = createSignal<Snapshot | null>(null);
    const [rows, setRows] = createSignal<Rec[]>([]);
    const [loading, setLoading] = createSignal(false);
    const [stats, setStats] = createSignal<{ scanned: number; ms: number; truncated: boolean } | null>(null);
    const [sel, setSel] = createSignal<string | null>(null);
    const [tab, setTab] = createSignal<"req" | "res">("req");
    // 筛选
    const [qText, setQText] = createSignal("");
    const [fStatus, setFStatus] = createSignal<StatusFilter>("all");
    const [fMethod, setFMethod] = createSignal("all");
    const [fDate, setFDate] = createSignal<string>(todayStr());
    const [dates, setDates] = createSignal<string[]>([]);
    const [logBytes, setLogBytes] = createSignal(0);
    // 告警条（开启「记录完整请求内容」时在页面上方醒目提示；关掉提示消失）
    const [alertOff, setAlertOff] = createSignal(false);
    // 列配置 / 排序 / 惰性加载
    const [cols, setCols] = createSignal<Record<ColKey, boolean>>(
        Object.fromEntries(COLUMNS.map((c) => [c.key, c.on])) as Record<ColKey, boolean>,
    );
    const [sortKey, setSortKey] = createSignal<ColKey | null>(null);
    const [sortDir, setSortDir] = createSignal<"asc" | "desc">("desc");
    const [shown, setShown] = createSignal(PAGE_SIZE);
    let tableScroll: HTMLDivElement | undefined;

    // 只取状态（开关 / 上限 / 目录）：记录一律走磁盘查询（query）。
    // 事件流每落一条请求就触发一次刷新，若这里把最多 500 条记录（每条正文可达几十 KB）
    // 一起拉回来丢掉，等于每次请求都白灌一遍 IPC。
    const loadSnapshot = async () => {
        setSnap(await diyService.diy.traffic.snapshot({ withRecords: false }));
    };
    const loadFiles = async () => {
        const r = await diyService.diy.traffic.logFiles({});
        setDates(r.dates);
        setLogBytes(r.bytes);
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
                limit: 5000,
            });
            setRows(res.records as unknown as Rec[]);
            setStats({ scanned: res.scanned, ms: res.ms, truncated: res.truncated });
            setShown(PAGE_SIZE);
            if (sel() !== null && !res.records.some((r) => keyOf(r as unknown as Rec) === sel())) setSel(null);
            // 列表重渲染后刷新页内查找的高亮（Range 会随节点重建而失效）
            findStore.refresh();
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
        void loadFiles();
        void runQuery();
        const ac = new AbortController();
        void diyService.diy.traffic
            .events({}, { signal: ac.signal })
            .then(async (stream) => {
                // 有新记录 / 开关变更 → 刷新状态，并（防抖）重查一次今日数据
                // 事件载荷只有版本号，界面不关心内容 —— 收到就刷新（`void ev` 同 localChatStore 惯例）
                for await (const ev of stream) {
                    void ev;
                    void loadSnapshot();
                    void loadFiles();
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
    const cur = () => rows().find((r) => keyOf(r) === sel()) ?? null;

    /** 排序后的行（点击表头切换列 / 方向） */
    const sortedRows = createMemo(() => {
        const all = rows();
        const k = sortKey();
        if (!k) return all;
        const dir = sortDir() === "asc" ? 1 : -1;
        return [...all].sort((a, b) => {
            const va = cellValue(a, k);
            const vb = cellValue(b, k);
            if (va.num != null && vb.num != null) return (va.num - vb.num) * dir;
            return va.text.localeCompare(vb.text) * dir;
        });
    });
    const visibleRows = createMemo(() => sortedRows().slice(0, shown()));
    const toggleSort = (k: ColKey) => {
        if (sortKey() === k) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(k);
            setSortDir("desc");
        }
    };
    /** 滚动到底部附近 → 追加一页（惰性加载） */
    const onTableScroll = () => {
        if (!tableScroll) return;
        if (tableScroll.scrollTop + tableScroll.clientHeight >= tableScroll.scrollHeight - 60) {
            if (shown() < sortedRows().length) setShown((n) => n + PAGE_SIZE);
        }
    };

    // 定位：优先 id → trace_id → 最近一次失败（在当前查询结果里找）
    /** 已经应用过的筛选提示（`text\0date`）—— 防止每次重渲染都重设筛选 → 无限重查（##310） */
    let focusFiltered: string | null = null;
    createEffect(() => {
        const f = opts.focus?.();
        // ⚠️ 必须在**分支之前**读一次 rows：否则"先设筛选、提前 return"那一轮没订阅查询结果，
        //    结果回来时本 effect 不会重跑 → 永远不定位（实测：跳过来只筛不选）。
        const all = rows();
        if (!f) {
            focusFiltered = null;
            return;
        }
        // ① 先应用筛选提示（目标那条可能不在当前筛选结果里，列表默认只查当天）：
        //    设条件 → 重查 → 等结果回来（rows 变化触发本 effect 重跑）再定位。
        const hint = f.text !== undefined || f.date !== undefined ? `${f.text ?? ""}\u0000${f.date ?? ""}` : null;
        if (hint && hint !== focusFiltered) {
            focusFiltered = hint;
            if (f.text !== undefined) setQText(f.text);
            if (f.date !== undefined) setFDate(f.date);
            scheduleQuery();
            return;
        }
        // ② 在结果里定位
        if (all.length === 0) return;
        let r = f.reqId != null ? all.find((x) => x.id === f.reqId) : undefined;
        if (!r && f.traceId) r = all.find((x) => x.traceId === f.traceId);
        // 只有调用方**没给线索**时才退化成"最近一次失败"：给了 text/traceId 说明它知道要哪一条，
        // 此时硬塞一条别的比空着更坏（会让人以为"就是这条"）。
        if (!r && !hint && !f.traceId) {
            const fails = all.filter(isFail);
            r = fails[fails.length - 1];
        }
        if (r) {
            setSel(keyOf(r));
            setTab(isFail(r) ? "res" : "req");
            opts.onFocusConsumed?.();
        }
    });

    const open = (r: Rec) => {
        setSel(keyOf(r));
        setTab(isFail(r) ? "res" : "req");
    };
    const toggleFullCapture = async () => {
        const on = !snap()?.fullCapture;
        const s = await diyService.diy.traffic.setFullCapture({ on });
        setSnap(s);
        setAlertOff(false); // 每次打开都重新醒目提示一次
    };

    return {
        snap, rows, loading, stats, sel, setSel, tab, setTab,
        qText, setQText, fStatus, setFStatus, fMethod, setFMethod, fDate, setFDate,
        dates, logBytes, alertOff, setAlertOff, cols, setCols, sortKey, sortDir, shown,
        methods, dateOptions, cur, sortedRows, visibleRows, toggleSort, onTableScroll,
        setTableEl: (el: HTMLDivElement | undefined) => (tableScroll = el),
        open, scheduleQuery, toggleFullCapture,
        /** 清理面板删完文件后刷新体积 / 日期下拉（##324） */
        loadFiles,
    };
}

export type TrafficState = ReturnType<typeof createTrafficState>;

/**
 * **请求列表**（左 viewset 的主体）：查询条 + 表格。
 * 抽屉形态里它是"没选中记录"时的默认面；页面形态里它独自占左 area。
 */
function TrafficTable(props: { st: TrafficState }) {
    const st = props.st;
    return (
        <div class="flex flex-col flex-1 min-h-0 gap-2">
            {/* 查询条：全文关键词 / 日期 / 状态 / 方法 / 列 */}
            <div class="flex items-center gap-2 flex-wrap shrink-0">
                <input
                    class="input input-bordered input-xs w-64"
                    placeholder="🔍 全文搜索（地址 / 状态 / 模型 / 正文…）"
                    value={st.qText()}
                    onInput={(e) => {
                        st.setQText(e.currentTarget.value);
                        st.scheduleQuery(300);
                    }}
                />
                <select
                    class="select select-xs"
                    value={st.fDate()}
                    onChange={(e) => {
                        st.setFDate(e.currentTarget.value);
                        st.scheduleQuery();
                    }}
                    title="数据按天存放；默认只看当天，可切到其它日期或全部"
                >
                    <option value={st.dateOptions().today}>{st.dateOptions().today}（今日）</option>
                    <For each={st.dateOptions().rest}>{(d) => <option value={d}>{d}</option>}</For>
                    <option value="all">全部日期</option>
                </select>
                <select
                    class="select select-xs"
                    value={st.fStatus()}
                    onChange={(e) => {
                        st.setFStatus(e.currentTarget.value as StatusFilter);
                        st.scheduleQuery();
                    }}
                >
                    <For each={STATUS_OPTIONS}>{(o) => <option value={o.v}>{o.label}</option>}</For>
                </select>
                <select
                    class="select select-xs"
                    value={st.fMethod()}
                    onChange={(e) => {
                        st.setFMethod(e.currentTarget.value);
                        st.scheduleQuery();
                    }}
                >
                    <option value="all">全部方法</option>
                    <For each={st.methods()}>{(m) => <option value={m}>{m}</option>}</For>
                </select>
                {/* 列配置：勾选显隐（对齐 devtools 的自定义列） */}
                <div class="dropdown dropdown-end">
                    <button class="btn btn-xs btn-ghost" tabindex={0}>
                        列 ▾
                    </button>
                    <ul
                        tabindex={0}
                        class="dropdown-content menu bg-base-100 border border-base-300 rounded-box z-[60] w-40 p-1 shadow"
                    >
                        <For each={COLUMNS}>
                            {(c) => (
                                <li>
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            class="checkbox checkbox-xs"
                                            checked={st.cols()[c.key]}
                                            onChange={(e) => {
                                                const v = e.currentTarget.checked;
                                                st.setCols((s) => ({ ...s, [c.key]: v }));
                                            }}
                                        />
                                        {c.label}
                                    </label>
                                </li>
                            )}
                        </For>
                    </ul>
                </div>
                <span class="text-caption opacity-50">
                    <Show when={st.loading()} fallback={<span>{st.rows().length} 条</span>}>
                        <span class="animate-pulse">查询中…</span>
                    </Show>
                </span>
                <Show when={!st.loading() && st.stats()}>
                    {(s) => (
                        <span class="text-caption opacity-40">
                            扫 {s().scanned} 行 · {s().ms}ms{s().truncated ? " · 已截断，请缩小范围" : ""}
                        </span>
                    )}
                </Show>
            </div>
            <div
                ref={(el) => st.setTableEl(el)}
                onScroll={st.onTableScroll}
                class="flex-1 min-h-0 overflow-auto border border-base-300 rounded"
            >
                <table class="table table-xs table-pin-rows w-full">
                    <thead>
                        <tr>
                            <For each={COLUMNS}>
                                {(c) => (
                                    <Show when={st.cols()[c.key]}>
                                        <th
                                            class={`${c.width ?? ""} cursor-pointer select-none hover:bg-base-200`}
                                            title={c.tip ? `${c.tip}（点击排序）` : "点击排序"}
                                            onClick={() => st.toggleSort(c.key)}
                                        >
                                            <span class={c.align === "right" ? "flex justify-end items-center gap-1" : "flex items-center gap-1"}>
                                                {c.label}
                                                <Show when={st.sortKey() === c.key}>
                                                    <span class="opacity-60">{st.sortDir() === "asc" ? "▲" : "▼"}</span>
                                                </Show>
                                            </span>
                                        </th>
                                    </Show>
                                )}
                            </For>
                        </tr>
                    </thead>
                    <tbody>
                        <Show when={st.rows().length === 0}>
                            <tr>
                                <td colspan={COLUMNS.filter((c) => st.cols()[c.key]).length} class="text-center opacity-50 py-6">
                                    {st.loading() ? "查询中…" : "没有符合筛选条件的记录"}
                                </td>
                            </tr>
                        </Show>
                        <For each={st.visibleRows()}>
                            {(r) => (
                                <tr
                                    class={`cursor-pointer hover:bg-base-200 ${st.sel() === keyOf(r) ? "bg-primary/10" : ""}`}
                                    onClick={() => st.open(r)}
                                    title={r.url}
                                >
                                    <Show when={st.cols().seqno}>
                                        <td class="text-right opacity-50" title={r.log ? `${r.log.file}:${r.log.line}` : "未落盘"}>
                                            {cellValue(r, "seqno").text}
                                        </td>
                                    </Show>
                                    <Show when={st.cols().status}>
                                        <td>
                                            <span class={`badge badge-sm ${statusCls(r)}`}>{statusText(r)}</span>
                                        </td>
                                    </Show>
                                    <Show when={st.cols().method}>
                                        <td class="font-mono">{r.method}</td>
                                    </Show>
                                    <Show when={st.cols().name}>
                                        <td class="font-mono truncate max-w-0">
                                            <span class="opacity-60">{r.host}</span>
                                            {r.path}
                                        </td>
                                    </Show>
                                    <Show when={st.cols().type}>
                                        <td class="opacity-70">{mimeType(r)}</td>
                                    </Show>
                                    <Show when={st.cols().size}>
                                        <td class="text-right">{fmtBytes(r.reqBytes + r.resBytes)}</td>
                                    </Show>
                                    <Show when={st.cols().duration}>
                                        <td class="text-right">{(r.ms / 1000).toFixed(2)}s</td>
                                    </Show>
                                    <Show when={st.cols().time}>
                                        <td class="opacity-60">{time(r.ts)}</td>
                                    </Show>
                                    <Show when={st.cols().source}>
                                        <td class="truncate">
                                            <span class="badge badge-ghost badge-sm">{kindLabel(r.kind)}</span>
                                            <Show when={r.model}>
                                                <span class="ml-1 opacity-60">{r.model.split("/").pop()}</span>
                                            </Show>
                                        </td>
                                    </Show>
                                    <Show when={st.cols().attempt}>
                                        <td class="text-right">{cellValue(r, "attempt").text}</td>
                                    </Show>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
                <Show when={st.shown() < st.sortedRows().length}>
                    <div class="text-center py-2 text-caption opacity-50">
                        已显示 {st.shown()} / {st.sortedRows().length} 条（继续下滑加载）
                    </div>
                </Show>
            </div>
        </div>
    );
}

/**
 * **基本信息**（左 viewset）：告警 + 开关/日志体积 + 说明 + 请求列表。
 * 页面形态下它就是左 area 的全部；抽屉形态下它只在"没选中记录"时出现（那里用 TrafficTable 即可）。
 */
export function TrafficList(props: { st: TrafficState; intro?: boolean }) {
    const st = props.st;
    return (
        <div class="flex flex-col gap-2 h-full min-h-0 p-2" data-traffic-list>
            {/* 开启「记录完整请求内容」时的醒目告警（daisyUI alert）。关掉即消失，不弹确认框。 */}
            <Show when={st.snap()?.fullCapture && !st.alertOff()}>
                <div class="alert alert-warning py-2 shrink-0" role="alert">
                    <span>
                        ⚠ 正在完整记录请求内容：正文不再截断，可能占用大量磁盘空间。本开关只在本次运行内有效，
                        应用退出后自动关闭。
                    </span>
                    <button class="btn btn-xs btn-ghost ml-auto" onClick={() => st.setAlertOff(true)}>
                        知道了
                    </button>
                </div>
            </Show>
            <div class="flex items-center gap-2 flex-wrap shrink-0">
                <span class="text-body opacity-70" title="磁盘日志总体积（按天切文件；log 等同 cache，可随时清理）">
                    日志 {fmtBytes(st.logBytes())} · {st.dateOptions().rest.length + 1} 个文件
                </span>
                <TrafficLogCleanButton
                    onDone={() => {
                        void st.loadFiles();
                        st.scheduleQuery();
                    }}
                />
                <div class="flex-1" />
                <button
                    class={`btn btn-xs ${st.snap()?.fullCapture ? "btn-error" : ""}`}
                    onClick={() => void st.toggleFullCapture()}
                    title={
                        st.snap()?.fullCapture
                            ? "正在完整记录：正文不再截断。点击关闭（关闭后恢复只留首尾一段）"
                            : "默认只保留正文开头 8K + 结尾 16K（中间省略）。开启后正文完整记录、不截断；会占用较多磁盘，应用退出时自动关闭。"
                    }
                >
                    {st.snap()?.fullCapture ? "● 完整记录中" : "记录完整请求内容"}
                </button>
            </div>
            <Show when={props.intro !== false}>
                <p class="text-caption opacity-50 shrink-0">
                    这里显示应用实际发出去的 HTTP 请求与收到的响应。记录一直开着，逐条写进磁盘日志（按天切文件），可用日期 + 关键词翻查历史。
                    超长正文默认只留首尾一段，需要完整时打开「记录完整请求内容」。
                </p>
            </Show>
            <TrafficTable st={st} />
        </div>
    );
}

/**
 * **请求 / 响应编辑器**（右 viewset）：选中记录的详情（概览 + 请求/响应两个 JsonViewer）。
 * `inline` = 抽屉形态（列表被它整体替换）→ 给「← 列表」返回；页面形态两栏并排，不需要返回。
 */
export function TrafficDetail(props: { st: TrafficState; inline?: boolean }) {
    const st = props.st;
    return (
        <Show when={st.cur()} fallback={<div class="p-4 text-body opacity-50">← 从左侧选一条请求查看详情</div>}>
            {(r) => (
                <div class={`flex flex-col gap-2 border border-base-300 rounded p-2 flex-1 min-h-0 ${props.inline ? "" : "m-2"}`} data-traffic-detail>
                    <div class="flex items-center gap-2 flex-wrap shrink-0">
                        <Show when={props.inline}>
                            <button class="btn btn-xs btn-ghost" onClick={() => st.setSel(null)}>
                                ← 列表
                            </button>
                        </Show>
                        <span class={`badge badge-sm ${statusCls(r())}`}>{statusText(r())}</span>
                        <span class="text-body opacity-60">{kindLabel(r().kind)}</span>
                        <Show when={r().model}>
                            <span class="text-body opacity-60">{r().model}</span>
                        </Show>
                        <Show when={r().kind === "llm"}>
                            <span
                                class="text-body opacity-60"
                                title={
                                    typeof r().stepSeq === "number"
                                        ? "第几个逻辑步 · 该步第几次 HTTP 往返（>1 即重试）"
                                        : "本 run 内第几次 HTTP 往返（跨步累计；老记录没有步号）"
                                }
                            >
                                {typeof r().stepSeq === "number" && typeof r().attemptInStep === "number"
                                    ? `第 ${r().stepSeq} 步 · 第 ${r().attemptInStep} 次往返`
                                    : `第 ${r().attempt} 次往返`}
                            </span>
                        </Show>
                        <span class="text-body opacity-60">{(r().ms / 1000).toFixed(2)}s</span>
                        <span class="text-body opacity-60" title="请求发出时刻（本地时区）">{time(r().ts)}</span>
                        <span class="text-body opacity-60" title="请求体 + 响应体字节数">
                            {fmtBytes(r().reqBytes + r().resBytes)}
                        </span>
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
                        <button role="tab" class={`tab ${st.tab() === "req" ? "tab-active" : ""}`} onClick={() => st.setTab("req")}>
                            请求
                        </button>
                        <button role="tab" class={`tab ${st.tab() === "res" ? "tab-active" : ""}`} onClick={() => st.setTab("res")}>
                            响应
                        </button>
                    </div>
                    <div class="flex-1 min-h-0 min-w-0">
                        <Show
                            when={st.tab() === "req"}
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
    );
}

/**
 * **抽屉形态**：列表 ⇄ 详情**原地切换**（贴当前对话查一条时，不该被拆成两个 area）。
 * 页面形态见 `TrafficPage`（同样这份 state，交给 ViewGrid 摆成左右两个 viewset）。
 */
export function TrafficView(props: {
    focus?: TrafficFocus | null;
    onFocusConsumed?: () => void;
    showIntro?: boolean;
}) {
    const st = createTrafficState({
        focus: () => props.focus ?? null,
        onFocusConsumed: props.onFocusConsumed,
    });
    return (
        <div class="flex flex-col gap-3 h-full min-h-0">
            {/* 开启「记录完整请求内容」时的醒目告警（daisyUI alert）。关掉即消失，不弹确认框。 */}
            <Show when={st.snap()?.fullCapture && !st.alertOff()}>
                <div class="alert alert-warning py-2 shrink-0" role="alert">
                    <span>
                        ⚠ 正在完整记录请求内容：正文不再截断，可能占用大量磁盘空间。本开关只在本次运行内有效，
                        应用退出后自动关闭。
                    </span>
                    <button class="btn btn-xs btn-ghost ml-auto" onClick={() => st.setAlertOff(true)}>
                        知道了
                    </button>
                </div>
            </Show>
            {/* 标题 + 日志体积 + 完整记录开关：**恒显**（抽屉形态只是不画 h2 标题，
                「日志多大 / 是否在完整记录」这两个状态任何形态都要看得见） */}
            <div class="flex items-center gap-2 flex-wrap shrink-0">
                <Show when={props.showIntro !== false}>
                    <h2 class="text-display font-bold mr-auto">流量</h2>
                </Show>
                <span class="text-body opacity-70" title="磁盘日志总体积（按天切文件；log 等同 cache，可随时清理）">
                    日志 {fmtBytes(st.logBytes())} · {st.dateOptions().rest.length + 1} 个文件
                </span>
                <TrafficLogCleanButton
                    onDone={() => {
                        void st.loadFiles();
                        st.scheduleQuery();
                    }}
                />
                <button
                    class={`btn btn-xs ${st.snap()?.fullCapture ? "btn-error" : ""}`}
                    onClick={() => void st.toggleFullCapture()}
                >
                    {st.snap()?.fullCapture ? "● 完整记录中" : "记录完整请求内容"}
                </button>
            </div>
            <Show when={props.showIntro !== false}>
                <p class="text-caption opacity-50 shrink-0">
                    这里显示应用实际发出去的 HTTP 请求与收到的响应。记录一直开着，逐条写进磁盘日志（按天切文件），可用日期 + 关键词翻查历史。
                    超长正文默认只留首尾一段，需要完整时打开「记录完整请求内容」。
                </p>
            </Show>
            <Show when={st.cur()} fallback={<TrafficTable st={st} />}>
                <TrafficDetail st={st} inline />
            </Show>
        </div>
    );
}

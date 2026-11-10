/**
 * renderer-react.tsx —— 「raw request log」插件（##518 第一个 devtools 插件）
 *
 * 干什么：把应用**真发出去的每个 HTTP 请求**列出来（时间 / 方法 / 状态 / 地址或模型 / 耗时），
 * 点一行看原始记录全文。只读 —— 这是「这次请求到底长什么样」的排障面。
 *
 * 依赖面只有 `DevtoolsHost.invoke`：宿主可以是 diy-app（进程内 IPC）、dev（h2c 连目标实例）、
 * diy2（自身 rpc）。插件不知道自己在哪跑。
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { PageContext, PageView } from "@diy-agent/workbench-ui";
import { createTrafficClient, type TrafficQuery, type TrafficClient } from "./client.js";
import type { TrafficEntry } from "./types.js";

/** 状态色：只按语义给 class，具体颜色由宿主的令牌决定（插件不定义视觉） */
function statusClass(entry: TrafficEntry): string {
    const status = entry.status;
    if (typeof status !== "number") return "dt-dim";
    if (status >= 500) return "dt-err";
    if (status >= 400) return "dt-warn";
    return "dt-ok";
}

function shortTime(at: string | undefined): string {
    if (at === undefined) return "—";
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return at;
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function label(entry: TrafficEntry): string {
    return entry.model !== undefined && entry.model !== "" ? String(entry.model) : String(entry.url ?? "—");
}

function TrafficView(props: { client: TrafficClient }) {
    const [query, setQuery] = React.useState<TrafficQuery>({ limit: 200 });
    const [text, setText] = React.useState("");
    const [rows, setRows] = React.useState<readonly TrafficEntry[]>([]);
    const [meta, setMeta] = React.useState<string>("");
    const [error, setError] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<TrafficEntry | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(
        async (q: TrafficQuery): Promise<void> => {
            setBusy(true);
            try {
                const res = await props.client.query(q);
                setRows(res.records);
                setMeta(`命中 ${String(res.hits)} 条 · 扫了 ${String(res.scanned)} 行 · ${String(res.ms)} ms${res.truncated ? " · 已截断" : ""}`);
                setError(null);
            } catch (e) {
                setRows([]);
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(false);
            }
        },
        [props.client],
    );

    React.useEffect(() => {
        void load(query);
    }, [load, query]);

    const submit = (event: React.FormEvent): void => {
        event.preventDefault();
        setQuery({ ...query, text: text.trim() === "" ? undefined : text.trim() });
    };

    return (
        <div className="dt-root">
            <form className="dt-bar" onSubmit={submit}>
                <input
                    className="dt-input"
                    aria-label="关键词"
                    placeholder="关键词（地址 / 模型 / 正文）"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                />
                <button type="submit" className="dt-btn" disabled={busy}>
                    {busy ? "查询中…" : "查询"}
                </button>
                <span className="dt-meta">{error ?? meta}</span>
            </form>
            <div className="dt-body">
                <table className="dt-table" role="table">
                    <thead>
                        <tr>
                            <th>时间</th>
                            <th>方法</th>
                            <th>状态</th>
                            <th>地址 / 模型</th>
                            <th>耗时</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((entry, index) => (
                            <tr
                                key={`${String(entry.at ?? "")}-${String(index)}`}
                                className={picked === entry ? "dt-row dt-picked" : "dt-row"}
                                role="row"
                                tabIndex={0}
                                onClick={() => setPicked(entry)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") setPicked(entry);
                                }}
                            >
                                <td>{shortTime(entry.at)}</td>
                                <td>{String(entry.method ?? entry.kind ?? "—")}</td>
                                <td className={statusClass(entry)}>{entry.status === undefined ? "—" : String(entry.status)}</td>
                                <td className="dt-truncate">{label(entry)}</td>
                                <td>{entry.ms === undefined ? "—" : `${String(Math.round(entry.ms))} ms`}</td>
                            </tr>
                        ))}
                        {rows.length === 0 && !busy ? (
                            <tr>
                                <td colSpan={5} className="dt-dim">
                                    （没有匹配的请求）
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
                <section className="dt-detail" aria-label="记录详情">
                    {picked === null ? (
                        <p className="dt-dim">左边点一行看原始记录</p>
                    ) : (
                        <pre className="dt-json">{JSON.stringify(picked, null, 2)}</pre>
                    )}
                </section>
            </div>
        </div>
    );
}

/**
 * workbench 页面契约（`PageView`）。
 * `render` 是同步挂载 + 返回销毁函数（与 workbench 的页面生命周期对齐）。
 */
export const trafficPageView: PageView = {
    id: "devtools-traffic",
    title: "请求",
    render(container: HTMLElement, ctx: PageContext): () => void {
        const client = createTrafficClient({ invoke: (m, a) => ctx.invoke(m, a) as Promise<never> });
        const root = createRoot(container);
        // 不套 StrictMode：它会把 effect 跑两遍 ⇒ 挂载时打两次 query（白费一次磁盘扫描）。
        // 生产页面也不需要它，测试里更难断言「只查一次」。
        root.render(<TrafficView client={client} />);
        return () => root.unmount();
    },
};

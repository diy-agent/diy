/**
 * ViewRenderer.tsx — **九种引擎侧通用渲染器**（##166 §14.7 / ##318 契约）。
 *
 * 判据（§13.2「把插件做薄」）：行业只写 **raw → 该渲染器的 data** 的形状翻译（`render` 插件），
 * 页面长什么样归这里 —— 行业一个字节的视图代码都不写。
 *
 * 数据形状的**真源**是 `@diy/flow` 的类型导出（`ViewShapes` / `ViewData`，##318 交付 A）——
 * 本文件按 `renderer` 收窄 `payload`，**不自持第二份形状**（自持一份必然与内核漂移）。
 * 但 `payload` 出参是 `unknown`（内核不管形状），故每个渲染器都做**最小结构校验**：
 * 形状不符就直说「形状不符」，不猜、不兜（猜出来的图会让人以为数据没问题）。
 */
import { For, Show, type JSX } from "solid-js";
import type { FlowRenderer } from "../../lib/flow-view";

type Tone = "ok" | "warn" | "danger" | "muted";

/** 语义色调 → 色值（行业只给语义，配色归引擎 —— 见 `@diy/flow` 的 `Tone` 注释） */
const TONE_COLOR: Record<Tone, string> = {
    ok: "#10b981",
    warn: "#f59e0b",
    danger: "#ef4444",
    muted: "#94a3b8",
};

const toneOf = (v: unknown): Tone => (v === "ok" || v === "warn" || v === "danger" || v === "muted" ? v : "muted");

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
    return typeof v === "string" ? v : null;
}
function arr(v: unknown): readonly unknown[] | null {
    return Array.isArray(v) ? v : null;
}
function numArr(v: unknown): number[] | null {
    const a = arr(v);
    if (!a || !a.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    return a as number[];
}
function strs(v: unknown): string[] | null {
    const a = arr(v);
    if (!a || !a.every((x) => typeof x === "string")) return null;
    return a as string[];
}

/** 形状不符的统一出口：说清是什么不符，别画半张图 */
function ShapeError(props: { renderer: FlowRenderer; why: string }) {
    return (
        <div class="rounded border border-error/40 bg-error/5 px-2 py-1 text-body text-error">
            {props.renderer} 形状不符：{props.why}
        </div>
    );
}

const Empty = (props: { text: string }) => <div class="px-1 py-1 text-body opacity-50">{props.text}</div>;

// ── doc ───────────────────────────────────────────────
function DocView(props: { payload: unknown }) {
    const text = () => (isObj(props.payload) ? str(props.payload["text"]) : null);
    return (
        <Show when={text()} fallback={<ShapeError renderer="doc" why="缺 text 字段" />}>
            {(t) => (
                <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-base-300/40 p-2 text-body">
                    {t()}
                </pre>
            )}
        </Show>
    );
}

// ── diff ──────────────────────────────────────────────
function DiffView(props: { payload: unknown }) {
    const lines = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["lines"]);
        if (!raw) return null;
        const out: Array<{ kind: "add" | "del" | "context"; text: string }> = [];
        for (const l of raw) {
            if (!isObj(l)) return null;
            const kind = l["kind"];
            const text = l["text"];
            if ((kind !== "add" && kind !== "del" && kind !== "context") || typeof text !== "string") return null;
            out.push({ kind, text });
        }
        return out;
    };
    const bg = (k: string) => (k === "add" ? "bg-success/15" : k === "del" ? "bg-error/15" : "");
    const mark = (k: string) => (k === "add" ? "+" : k === "del" ? "-" : " ");
    return (
        <Show when={lines()} fallback={<ShapeError renderer="diff" why="缺 lines[]（每行 {kind,text}）" />}>
            {(ls) => (
                <div class="max-h-40 overflow-auto rounded bg-base-300/30 p-1 font-mono text-body leading-snug">
                    <For each={ls()}>
                        {(l) => (
                            <div class={`whitespace-pre-wrap break-words px-1 ${bg(l.kind)}`}>
                                {mark(l.kind)} {l.text}
                            </div>
                        )}
                    </For>
                </div>
            )}
        </Show>
    );
}

// ── table ─────────────────────────────────────────────
function TableView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["rows"]);
        if (!raw) return null;
        const rows: Array<{ cells: string[]; tone: Tone }> = [];
        for (const r of raw) {
            if (!isObj(r)) return null;
            const cells = arr(r["cells"]);
            if (!cells) return null;
            rows.push({ cells: cells.map((c) => (typeof c === "string" ? c : c === null || c === undefined ? "" : String(c))), tone: toneOf(r["tone"]) });
        }
        const columns = props.payload["columns"] === undefined ? null : strs(props.payload["columns"]);
        return { columns, rows };
    };
    return (
        <Show when={data()} fallback={<ShapeError renderer="table" why="缺 rows[]（每行 {cells}）" />}>
            {(d) => (
                <div class="max-h-40 overflow-auto">
                    <table class="table table-xs w-full">
                        <Show when={d().columns}>
                            {(cols) => (
                                <thead>
                                    <tr>
                                        <For each={cols()}>{(c) => <th class="text-body opacity-70">{c}</th>}</For>
                                    </tr>
                                </thead>
                            )}
                        </Show>
                        <tbody>
                            <For each={d().rows}>
                                {(r) => (
                                    <tr>
                                        <For each={r.cells}>
                                            {(c, i) => (
                                                <td class="text-body" style={i() === 0 ? { color: TONE_COLOR[r.tone] } : undefined}>
                                                    {c}
                                                </td>
                                            )}
                                        </For>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                </div>
            )}
        </Show>
    );
}

// ── timeline ──────────────────────────────────────────
function TimelineView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["items"]);
        if (!raw) return null;
        const items: Array<{ label: string; start: number; end: number; color: string }> = [];
        for (const it of raw) {
            if (!isObj(it)) return null;
            const label = str(it["label"]);
            const start = num(it["start"]);
            const end = num(it["end"]);
            if (label === null || start === null || end === null) return null;
            items.push({ label, start, end, color: str(it["color"]) ?? TONE_COLOR[toneOf(it["tone"])] });
        }
        const ruler = props.payload["ruler"] === undefined ? null : strs(props.payload["ruler"]);
        const total = Math.max(1, ...items.map((i) => i.end));
        return { items, ruler, total };
    };
    return (
        <Show when={data()} fallback={<ShapeError renderer="timeline" why="缺 items[]（{label,start,end}）" />}>
            {(d) => (
                <div class="flex flex-col gap-1">
                    <For each={d().items}>
                        {(it) => (
                            <div class="flex items-center gap-1">
                                <span class="w-16 shrink-0 truncate text-body opacity-70" title={it.label}>
                                    {it.label}
                                </span>
                                <div class="relative h-4 flex-1 rounded bg-base-300/40">
                                    <div
                                        class="absolute inset-y-0 rounded"
                                        style={{
                                            left: `${(it.start / d().total) * 100}%`,
                                            width: `${Math.max(1.5, ((it.end - it.start) / d().total) * 100)}%`,
                                            background: it.color,
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </For>
                    <Show when={d().ruler}>
                        {(r) => (
                            <div class="flex justify-between pl-16 text-body opacity-50">
                                <For each={r()}>{(t) => <span>{t}</span>}</For>
                            </div>
                        )}
                    </Show>
                </div>
            )}
        </Show>
    );
}

// ── video ─────────────────────────────────────────────
function VideoView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        return {
            src: str(props.payload["src"]),
            poster: str(props.payload["poster"]),
            duration: num(props.payload["duration"]),
            at: num(props.payload["at"]),
        };
    };
    return (
        <Show when={data()} fallback={<ShapeError renderer="video" why="payload 不是对象" />}>
            {(d) => (
                <div class="rounded border border-base-300 bg-base-300/30 p-2">
                    <div class="flex h-20 items-center justify-center rounded bg-base-300/60 text-body opacity-60">
                        {d().src ? "▶ 播放器（src 已给）" : "▶ 无 src（仅元数据）"}
                    </div>
                    <div class="mt-1 flex justify-between text-body opacity-70">
                        <span>{d().poster ?? "无封面"}</span>
                        <span>
                            {d().duration !== null ? `${d().duration}s` : "时长未知"}
                            {d().at !== null ? ` · 播放头 ${d().at}s` : ""}
                        </span>
                    </div>
                </div>
            )}
        </Show>
    );
}

// ── badge ─────────────────────────────────────────────
function BadgeView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["badges"]);
        if (!raw) return null;
        const out: Array<{ label: string; tone: Tone }> = [];
        for (const b of raw) {
            if (!isObj(b)) return null;
            const label = str(b["label"]);
            if (label === null) return null;
            out.push({ label, tone: toneOf(b["tone"]) });
        }
        return out;
    };
    return (
        <Show when={data()} fallback={<ShapeError renderer="badge" why="缺 badges[]（{label,tone}）" />}>
            {(bs) => (
                <div class="flex flex-wrap gap-1">
                    <For each={bs()}>
                        {(b) => (
                            <span
                                class="rounded px-1.5 py-0.5 text-body"
                                style={{ background: `${TONE_COLOR[b.tone]}22`, color: TONE_COLOR[b.tone], border: `1px solid ${TONE_COLOR[b.tone]}55` }}
                            >
                                {b.label}
                            </span>
                        )}
                    </For>
                </div>
            )}
        </Show>
    );
}

// ── kline ─────────────────────────────────────────────
function KlineView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["candles"]);
        if (!raw) return null;
        const cs: Array<{ t: string; o: number; h: number; l: number; c: number }> = [];
        for (const c of raw) {
            if (!isObj(c)) return null;
            const t = str(c["t"]);
            const o = num(c["o"]);
            const h = num(c["h"]);
            const l = num(c["l"]);
            const cl = num(c["c"]);
            if (t === null || o === null || h === null || l === null || cl === null) return null;
            cs.push({ t, o, h, l, c: cl });
        }
        return cs;
    };
    const W = 300;
    const H = 120;
    return (
        <Show when={data()} fallback={<ShapeError renderer="kline" why="缺 candles[]（{t,o,h,l,c}）" />}>
            {(cs) => {
                const hi = () => Math.max(...cs().map((c) => c.h));
                const lo = () => Math.min(...cs().map((c) => c.l));
                const y = (v: number) => (hi() === lo() ? H / 2 : H - ((v - lo()) / (hi() - lo())) * (H - 8) - 4);
                const step = () => W / Math.max(1, cs().length);
                return (
                    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-flow-kline="">
                        <For each={cs()}>
                            {(c, i) => {
                                const cx = () => i() * step() + step() / 2;
                                const up = () => c.c >= c.o;
                                return (
                                    <g stroke={up() ? "#ef4444" : "#10b981"} fill={up() ? "#ef4444" : "#10b981"}>
                                        <line x1={cx()} x2={cx()} y1={y(c.h)} y2={y(c.l)} stroke-width="1" />
                                        <rect
                                            x={cx() - Math.max(0.6, step() * 0.3)}
                                            width={Math.max(1.2, step() * 0.6)}
                                            y={Math.min(y(c.o), y(c.c))}
                                            height={Math.max(1, Math.abs(y(c.o) - y(c.c)))}
                                        />
                                    </g>
                                );
                            }}
                        </For>
                    </svg>
                );
            }}
        </Show>
    );
}

// ── heatmap ───────────────────────────────────────────
function HeatmapView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const raw = arr(props.payload["cells"]);
        if (!raw) return null;
        const cells: Array<{ value: number; tint: number }> = [];
        for (const c of raw) {
            if (!isObj(c)) return null;
            const value = num(c["value"]);
            if (value === null) return null;
            cells.push({ value, tint: num(c["tint"]) ?? Number.NaN });
        }
        const given = cells.filter((c) => Number.isFinite(c.tint));
        const vals = cells.map((c) => c.value);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        for (const c of cells) {
            if (!Number.isFinite(c.tint)) c.tint = max === min ? 0.5 : (c.value - min) / (max - min);
        }
        // 列数：契约只说「按行优先铺」⇒ 引擎取近似方阵（无列信息时最不偏的形状）
        return { cells, cols: Math.max(1, Math.round(Math.sqrt(cells.length))), normalized: given.length === 0 };
    };
    const mix = (t: number) => `rgba(59,130,246,${0.15 + 0.85 * Math.max(0, Math.min(1, t))})`;
    return (
        <Show when={data()} fallback={<ShapeError renderer="heatmap" why="缺 cells[]（{value,tint?}）" />}>
            {(d) => (
                <div
                    class="grid w-full gap-px"
                    style={{ "grid-template-columns": `repeat(${d().cols}, minmax(0, 1fr))` }}
                    data-flow-heatmap=""
                >
                    <For each={d().cells}>
                        {(c) => (
                            <div
                                class="aspect-square rounded-sm"
                                style={{ background: mix(c.tint) }}
                                title={`${c.value}${d().normalized ? "（引擎按 value 归一）" : ""}`}
                            />
                        )}
                    </For>
                </div>
            )}
        </Show>
    );
}

// ── equity ────────────────────────────────────────────
function EquityView(props: { payload: unknown }) {
    const data = () => {
        if (!isObj(props.payload)) return null;
        const nav = numArr(props.payload["nav"]);
        if (!nav || nav.length < 2) return null;
        const dd = props.payload["drawdown"] === undefined ? null : numArr(props.payload["drawdown"]);
        return { nav, dd, mark: props.payload["markDrawdown"] === true };
    };
    const W = 300;
    const H = 100;
    return (
        <Show when={data()} fallback={<ShapeError renderer="equity" why="缺 nav[]（至少 2 点）" />}>
            {(d) => {
                const hi = () => Math.max(...d().nav);
                const lo = () => Math.min(...d().nav);
                const x = (i: number) => (i / Math.max(1, d().nav.length - 1)) * W;
                const y = (v: number) => (hi() === lo() ? H / 2 : H - ((v - lo()) / (hi() - lo())) * (H - 10) - 5);
                const path = () => d().nav.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
                /** 最大回撤点（`markDrawdown` 时标出）：回撤序列的最小值处 */
                const ddLow = () => {
                    const dd = d().dd;
                    if (!dd || !d().mark) return null;
                    let idx = 0;
                    for (let i = 1; i < dd.length; i++) if (dd[i]! < dd[idx]!) idx = i;
                    return idx;
                };
                return (
                    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-flow-equity="">
                        <path d={path()} fill="none" stroke="#3b82f6" stroke-width="1.6" />
                        <Show when={ddLow()}>
                            {(i) => (
                                <g>
                                    <circle cx={x(i())} cy={y(d().nav[i()] ?? lo())} r="3" fill="#ef4444" />
                                    <line x1={x(i())} x2={x(i())} y1="0" y2={H} stroke="#ef4444" stroke-dasharray="3 3" stroke-width="1" />
                                </g>
                            )}
                        </Show>
                    </svg>
                );
            }}
        </Show>
    );
}

const RENDERERS_UI: Record<FlowRenderer, (p: { payload: unknown }) => JSX.Element> = {
    doc: (p) => <DocView payload={p.payload} />,
    diff: (p) => <DiffView payload={p.payload} />,
    table: (p) => <TableView payload={p.payload} />,
    timeline: (p) => <TimelineView payload={p.payload} />,
    video: (p) => <VideoView payload={p.payload} />,
    badge: (p) => <BadgeView payload={p.payload} />,
    kline: (p) => <KlineView payload={p.payload} />,
    heatmap: (p) => <HeatmapView payload={p.payload} />,
    equity: (p) => <EquityView payload={p.payload} />,
};

/** 九种渲染器的唯一入口：`renderer` 不认识就直说（别静默画空） */
export function renderFlowView(renderer: FlowRenderer, payload: unknown): JSX.Element {
    const fn = RENDERERS_UI[renderer];
    if (!fn) return <Empty text={`未知渲染器：${renderer}`} />;
    return fn({ payload });
}

/**
 * CompactSessionPanel — 压缩会话上下文（清零 → 硬切换新 session 的 UI）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩（本面板）：只改「发给模型的上下文」—— 保留最近 N 轮 + 可选裁工具结果；
 *     **不删任何历史**，旧内容仍在会话日志里、可查（历史代）、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 与本面板是两回事，别混。
 *
 * 布局（2026-10-05 定稿）：**左参数 + 右预览**，一眼对照。
 *   · base = 当前生效请求（requestView，打开面板取一次）
 *   · mod  = 改参数后请求（compactPreview 随参数刷新）
 *   · 右栏把两者渲染成 YAML 行、做行级 diff（增删变色、可折叠、可只看差异、可并排）
 *   · 左栏底部「事实表」= base↔mod 分层 token 与金额差（旧值 / 新值 / 省 cost）
 */

import { createSignal, createResource, createEffect, on, For, Show, createMemo, onMount, onCleanup, type JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import {
    DEFAULT_BUDGET_BYTES,
    DEFAULT_TOOL_RESULT_POLICY,
    budgetBytesOf,
    flatPolicyOf,
    normalizePolicy,
    toolResultOf,
    type CompactPolicy,
} from "../../shared/context/compaction";
/** 触发理由的短文案（表里空间小；完整版在 TRIGGER_TEXT_FULL，提示条上用） */
function triggerText(t: string | undefined): string {
    switch (t) {
        case "systemContextChanged":
            return "系统上下文变";
        case "cacheExpired":
            return "缓存过期";
        case "contextWindowOver":
            return "窗口超限";
        default:
            return "手动";
    }
}

import {
    collapsedAtLevel,
    diffValues,
    foldLevelCount,
    subtreeChanges,
    visibleDiffRows,
    type YamlDiffRow,
} from "../../shared/yaml-lines";
import { requestViewYaml, type LayerRow, type RequestView } from "../../shared/context/request-view";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { DrawerMaxButton } from "./DrawerMaximize";

const INDENT = "  ";

/** 该折叠行子树内是否含变更（add/del/change 任意） */
const hasOwnChange = (c?: { add: number; del: number }): boolean => !!c && (c.add > 0 || c.del > 0);

/** 折叠框（VSCode 式：标题条整条可点，▾/▸ 指示）—— 与 TaskDetailContent 的 Block 同形 */
function Block(props: { title: string; children: JSX.Element; defaultOpen?: boolean; extra?: string }) {
    const [open, setOpen] = createSignal(props.defaultOpen !== false);
    return (
        <section class="border border-base-300 rounded-lg overflow-hidden min-w-0">
            <button
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide opacity-80 hover:opacity-100"
                aria-expanded={open()}
                onClick={() => setOpen((v) => !v)}
            >
                <span>{open() ? "▾" : "▸"}</span>
                <span>{props.title}</span>
                <Show when={props.extra}>
                    <span class="ml-auto font-mono font-normal opacity-70">{props.extra}</span>
                </Show>
            </button>
            <Show when={open()}>
                <div class="p-2 min-w-0">{props.children}</div>
            </Show>
        </section>
    );
}

/**
 * 「压缩后估算」一行：压缩前 / 压缩后 / 预估节省。
 * 用层级符号（├/└，与「会话用量（累计）」同一套）表达「各行之和 = 合计」——
 * 合计行不加「（= 各层之和）」这类注释，层级关系用符号自明。
 */
function FactRow(props: { row: LayerRow; isTotal: boolean; isLast: boolean }) {
    const saved = () => props.row.costDelta < 0;
    const zero = () => Math.abs(props.row.costDelta) < 1e-9;
    const symbol = () => (props.isTotal ? "" : props.isLast ? "└ " : "├ ");
    return (
        <tr title={props.row.label} class={props.isTotal ? "font-semibold" : ""}>
            <td class="pr-2 whitespace-nowrap">
                <span class={props.isTotal ? "" : "opacity-50 font-mono"}>{symbol()}</span>
                {props.row.name}
            </td>
            <td class="text-right tabular-nums opacity-70">{props.row.oldTokens.toLocaleString()}</td>
            <td class="text-right tabular-nums">{props.row.newTokens.toLocaleString()}</td>
            <td class={`text-right tabular-nums ${saved() ? "text-success" : zero() ? "opacity-50" : "text-error"}`}>
                {zero() ? "0" : `${props.row.costDelta < 0 ? "−" : "+"}$${Math.abs(props.row.costDelta).toFixed(4)}`}
            </td>
        </tr>
    );
}

export function CompactSessionPanel(props: { uri: string; onClose: () => void }) {
    // ── 自动压缩检测（只读）：事实 / 触发理由 / 生效 TTL / 当前配置 ──
    const [auto, { refetch: refetchAuto }] = createResource(() => props.uri, async (u) => {
        return (await localChatStore.autoCompactStatus(u)) as {
            config: {
                mode: "off" | "notify" | "auto";
                triggers: { systemContextChanged: boolean; cacheExpired: boolean; contextWindowOver: number };
                policy: unknown;
            };
            facts: {
                systemContextChanged: boolean;
                sinceLastRequestMs: number | null;
                ttl: { knownAlive: number; maybeDead: number; prior: number; bounded: boolean; priorFalsified: boolean };
                windowRatio: number | null;
            };
            triggers: string[];
            reasons: string[];
        };
    });
    const [autoBusy, setAutoBusy] = createSignal(false);
    /** 触发条件与状态区是否展开（默认收起：先看「压到多少」，要调再展开） */
    const [autoCfgOpen, setAutoCfgOpen] = createSignal(false);
    const patchAuto = async (patch: Record<string, unknown>) => {
        setAutoBusy(true);
        try {
            await localChatStore.autoCompactSetConfig(patch);
            await refetchAuto();
        } finally {
            setAutoBusy(false);
        }
    };
    const setAutoMode = (mode: "off" | "notify" | "auto") => void patchAuto({ mode });

    /**
     * 【合并】压缩预算 —— 自动与手动**同一套策略**（用户 2026-10-07：
     * 「所有压缩都改为自动压缩策略 …… 提供手工压缩执行的按钮」）。
     * 真源 = `$DIY_HOME/auto-compact.yaml` 的 `policy`（`mode:"budget"`）。
     * 平时按触发条件自动压；下面「立即压缩」= 用同一个预算立刻压一次。
     */
    const autoPolicy = (): CompactPolicy => normalizePolicy(auto()?.config.policy);
    /** 预算（字节）；非预算策略（旧 keep/reset）时回落到缺省 */
    const budgetBytes = (): number => budgetBytesOf(autoPolicy()) ?? DEFAULT_BUDGET_BYTES;
    const patchAutoPolicy = (next: CompactPolicy) => void patchAuto({ policy: next });
    /** 把工具结果的呈现（内部旋钮）从当前策略里取出来、缺省用头尾裁剪 */
    const currentToolResult = () => toolResultOf(autoPolicy()) ?? DEFAULT_TOOL_RESULT_POLICY;
    const setBudgetBytes = (b: number) =>
        patchAutoPolicy({ mode: "budget", budgetBytes: Math.max(0, Math.round(b)), toolResult: currentToolResult(), summary: false });
    const setBudgetKb = (kb: number) => setBudgetBytes(kb * 1024);

    /** 预算输入框草稿（KB）：不要让异步 auto() 覆盖用户正在输入的内容 —— 仅初始化/提交时同步 */
    const [kbDraft, setKbDraft] = createSignal("3");
    createEffect(
        on(
            () => budgetBytes(),
            (b) => setKbDraft(b % 1024 === 0 ? String(b / 1024) : (b / 1024).toFixed(1)),
            { defer: false },
        ),
    );
    const commitKb = () => {
        const kb = Number(kbDraft());
        if (Number.isFinite(kb) && kb >= 0) setBudgetKb(kb);
        else setKbDraft(String(budgetBytes() / 1024));
    };

    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);
    /** 抽屉高度（px）：贴着上方、从底部拖拽调整；默认 2/3 屏高 */
    const [height, setHeight] = createSignal(Math.round(window.innerHeight * 0.66));
    const [maximized, setMaximized] = createSignal(false);
    const drawerHeight = () => (maximized() ? window.innerHeight : height());
    const startResize = (e: MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = height();
        const move = (ev: MouseEvent) => {
            setMaximized(false);
            const h = Math.round(startH + ev.clientY - startY);
            setHeight(Math.min(window.innerHeight - 8, Math.max(180, h)));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    // 右栏视图控制
    const [sideBySide, setSideBySide] = createSignal(false);
    const [onlyDiff, setOnlyDiff] = createSignal(true);
    /** 展开层级：0 = 只露根行；N = 全展开 */
    const [expandLevel, setExpandLevel] = createSignal(Number.MAX_SAFE_INTEGER);
    const turnCount = () => localChatStore.trees.length;

    /** 时长人读（用于"距上次请求"与 TTL 区间）；null/-1 = 未知 */
    const fmtGap = (ms: number | null): string => {
        if (ms === null || ms < 0) return "—";
        const m = ms / 60000;
        if (m < 1) return "<1 分钟";
        if (m < 60) return `${Math.round(m)} 分钟`;
        const h = m / 60;
        return h < 48 ? `${h.toFixed(1)} 小时` : `${Math.round(h / 24)} 天`;
    };
    const fmtPct = (r: number | null): string => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

    // base 请求（打开面板取一次，参数变化不重取）
    const [base] = createResource(() => props.uri, (u) => localChatStore.requestView(u) as Promise<RequestView>);

    // 预览（只算不写）：预算变化即重算
    const [pv] = createResource(
        () => ({ uri: props.uri, p: flatPolicyOf(autoPolicy()) }),
        (k) => localChatStore.compactPreview(k.uri, k.p) as Promise<{
            before: { bytes: number };
            after: { bytes: number };
            keptTurns: number;
            droppedTurns: number;
            facts: LayerRow[];
            modRequest: RequestView;
        }>,
    );

    // 两级 diff：以两个请求**对象**做节点级对齐
    const rows = createMemo<YamlDiffRow[]>(() => {
        const b = base();
        const m = pv();
        if (!b || !m) return [];
        return diffValues(requestViewYaml(b), requestViewYaml(m.modRequest));
    });

    const foldLevels = createMemo(() => foldLevelCount(rows()));
    const curLevel = createMemo(() => Math.min(expandLevel(), foldLevels()));
    const nextLevel = () => {
        const n = foldLevels();
        setExpandLevel((v) => (Math.min(v, n) >= n ? 0 : Math.min(v, n) + 1));
    };

    /** 手动折叠覆盖 */
    const [manual, setManual] = createSignal<{ level: number; collapsed: Set<number> }>({ level: -1, collapsed: new Set() });
    const toggleFold = (i: number) => {
        const cur = new Set(collapsed());
        if (cur.has(i)) cur.delete(i);
        else cur.add(i);
        setManual({ level: curLevel(), collapsed: cur });
    };
    createEffect(on(curLevel, () => setManual({ level: -1, collapsed: new Set() }), { defer: true }));

    const collapsed = createMemo<Set<number>>(() => {
        const lv = curLevel();
        const m = manual();
        return m.level === lv ? m.collapsed : collapsedAtLevel(rows(), lv);
    });
    const changes = createMemo(() => subtreeChanges(rows()));
    const shownIndexes = createMemo(() => visibleDiffRows(rows(), collapsed()));
    const rowCache = new Map<number, { i: number; row: YamlDiffRow }>();
    const CONTEXT_LINES = 3;
    const renderRows = createMemo(() => {
        const idx = shownIndexes();
        const all = rows();
        const ch = changes();
        const keep = new Set<number>();
        if (onlyDiff()) {
            idx.forEach((ri, pos) => {
                const row = all[ri]!;
                if (row.t !== "same" || (row.foldable && hasOwnChange(ch.get(ri)))) keep.add(pos);
            });
            idx.forEach((ri, pos) => {
                if (all[ri]!.t === "same") return;
                for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
                    const q = pos + d;
                    if (q >= 0 && q < idx.length) keep.add(q);
                }
            });
        }
        return idx
            .map((i, pos) => ({ i, pos }))
            .filter(({ pos }) => !onlyDiff() || keep.has(pos))
            .map(({ i }) => {
                const row = all[i]!;
                const cached = rowCache.get(i);
                if (cached && cached.row === row) return cached;
                const obj = { i, row };
                rowCache.set(i, obj);
                return obj;
            });
    });

    /** 立即压缩：按当前预算压一次（历史保留、可撤销） */
    const apply = async () => {
        setBusy(true);
        setErr(null);
        try {
            await localChatStore.compact(props.uri, flatPolicyOf(autoPolicy()));
            props.onClose();
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
        }
    };
    onMount(() => document.addEventListener("keydown", onKey, true));
    onCleanup(() => document.removeEventListener("keydown", onKey, true));

    const estTok = (bytes: number) => Math.round(bytes / 4);
    const ratio = () => {
        const b = pv()?.before.bytes ?? 0;
        const a = pv()?.after.bytes ?? 0;
        return b > 0 ? Math.round((1 - a / b) * 100) : 0;
    };
    const diffCounts = createMemo(() => {
        let add = 0, del = 0;
        for (const r of rows()) {
            if (r.t === "add") add++;
            else if (r.t === "del") del++;
            else if (r.t === "change") { add++; del++; }
        }
        return { add, del };
    });

    return (
        <div class="fixed inset-0 z-50 flex flex-col" onClick={props.onClose}>
            <div class="absolute inset-0 bg-black/30" />
            <div
                class="relative flex shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl"
                style={{ height: `${drawerHeight()}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                <div class={`px-4 border-b flex items-center justify-between shrink-0 ${VIEW_BAR_H}`}>
                    <div class="font-bold text-title">压缩会话上下文</div>
                    <div class="text-caption opacity-70">
                        当前 {estTok(pv()?.before.bytes ?? 0).toLocaleString()} tok → 压缩后{" "}
                        {estTok(pv()?.after.bytes ?? 0).toLocaleString()} tok{" "}
                        <span class="text-success">(-{ratio()}%)</span>
                        <span class="opacity-60">　删 {diffCounts().del} / 增 {diffCounts().add} 行</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>

                <div class="flex min-h-0 grow overflow-hidden">
                    {/* ── 左栏：压缩预算（自动 / 手动合一）+ 压缩后估算 ── */}
                    <div class="w-[340px] shrink-0 border-r overflow-auto p-2 space-y-2">
                        <div class="rounded-lg border border-base-300 p-2 space-y-2">
                            <div class="text-caption font-semibold opacity-70">压缩预算</div>
                            <div class="text-caption opacity-60">
                                ⓘ 只给一个上限：历史消息最多占这么多字节（固定开支不占）。系统按优先级
                                <b> 用户发言 &gt; 助手结论 &gt; 助手过程 &gt; 工具命令 &gt; 工具结果 </b>
                                保留，尽量填满；小的排后面，先丢。**实时运算**，会话再长也按此上限。
                            </div>

                            {/* 预算输入 + 预设 */}
                            <div class="flex items-center gap-1.5 text-caption">
                                <span>压缩到</span>
                                <input
                                    type="number"
                                    class="input input-xs w-20"
                                    aria-label="压缩预算KB"
                                    min="0"
                                    value={kbDraft()}
                                    disabled={autoBusy()}
                                    onInput={(e) => setKbDraft(e.currentTarget.value)}
                                    onChange={commitKb}
                                    onBlur={commitKb}
                                />
                                <span>KB</span>
                                <div class="flex-1" />
                                <button
                                    class="btn btn-ghost btn-xs"
                                    aria-label="预设清零"
                                    disabled={autoBusy()}
                                    onClick={() => setBudgetKb(0)}
                                >
                                    清零
                                </button>
                                <button
                                    class="btn btn-ghost btn-xs"
                                    aria-label="预设不压缩"
                                    disabled={autoBusy()}
                                    onClick={() => setBudgetKb(1024 * 1024)}
                                >
                                    不压缩
                                </button>
                            </div>

                            {/* 何时压（系统行为）：模式 + 触发条件 */}
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-caption opacity-70">何时自动压</span>
                                <select
                                    class="select select-xs"
                                    aria-label="自动压缩模式"
                                    value={auto()?.config.mode ?? "notify"}
                                    disabled={autoBusy()}
                                    onChange={(e) => setAutoMode(e.currentTarget.value as "off" | "notify" | "auto")}
                                >
                                    <option value="off">关闭检测</option>
                                    <option value="notify">检测并提示</option>
                                    <option value="auto">自动执行</option>
                                </select>
                            </div>

                            <button
                                class="btn btn-ghost btn-xs w-full justify-between"
                                aria-label="自动压缩配置开关"
                                onClick={() => setAutoCfgOpen((v) => !v)}
                            >
                                <span>{autoCfgOpen() ? "▾" : "▸"} 触发条件与状态</span>
                            </button>
                            <Show when={autoCfgOpen()}>
                                <div class="space-y-2 pl-1">
                                    <div class="text-caption opacity-70 space-y-0.5">
                                        <div>
                                            距上次请求 {fmtGap(auto()?.facts.sinceLastRequestMs ?? null)}
                                            {" · "}生效 TTL{" "}
                                            <Show
                                                when={auto()?.facts.ttl.bounded}
                                                fallback={<span>（实测不足，用先验 {fmtGap(auto()?.facts.ttl.prior ?? null)}）</span>}
                                            >
                                                {`(${fmtGap(auto()?.facts.ttl.knownAlive ?? null)}, ${fmtGap(auto()?.facts.ttl.maybeDead ?? null)}]`}
                                            </Show>
                                        </div>
                                        <div>窗口占用 {fmtPct(auto()?.facts.windowRatio ?? null)}</div>
                                        <div>系统上下文 {auto()?.facts.systemContextChanged ? "**已变化**" : "未变化"}</div>
                                    </div>
                                    <div class="space-y-1">
                                        <div class="text-caption font-semibold opacity-70">触发条件</div>
                                        <label class="flex items-center justify-between gap-2 cursor-pointer text-caption">
                                            <span>系统上下文变化</span>
                                            <input
                                                type="checkbox"
                                                class="toggle toggle-xs toggle-primary"
                                                aria-label="触发：系统上下文变化"
                                                disabled={autoBusy()}
                                                checked={auto()?.config.triggers.systemContextChanged ?? true}
                                                onChange={(e) =>
                                                    void patchAuto({
                                                        triggers: { ...auto()!.config.triggers, systemContextChanged: e.currentTarget.checked },
                                                    })
                                                }
                                            />
                                        </label>
                                        <label class="flex items-center justify-between gap-2 cursor-pointer text-caption">
                                            <span>缓存过期</span>
                                            <input
                                                type="checkbox"
                                                class="toggle toggle-xs toggle-primary"
                                                aria-label="触发：缓存过期"
                                                disabled={autoBusy()}
                                                checked={auto()?.config.triggers.cacheExpired ?? true}
                                                onChange={(e) =>
                                                    void patchAuto({
                                                        triggers: { ...auto()!.config.triggers, cacheExpired: e.currentTarget.checked },
                                                    })
                                                }
                                            />
                                        </label>
                                        <label class="flex items-center justify-between gap-2 text-caption">
                                            <span>窗口占用超过</span>
                                            <span class="flex items-center gap-1">
                                                <input
                                                    type="number"
                                                    class="input input-xs w-16"
                                                    aria-label="触发：窗口占用阈值"
                                                    min="0"
                                                    max="100"
                                                    value={Math.round((auto()?.config.triggers.contextWindowOver ?? 0.8) * 100)}
                                                    onChange={(e) =>
                                                        void patchAuto({
                                                            triggers: {
                                                                ...auto()!.config.triggers,
                                                                contextWindowOver: Math.min(1, Math.max(0, Number(e.currentTarget.value) / 100)),
                                                            },
                                                        })
                                                    }
                                                />
                                                <span class="opacity-60">%（0 = 关闭）</span>
                                            </span>
                                        </label>
                                    </div>
                                </div>
                            </Show>

                            <Show
                                when={(auto()?.triggers.length ?? 0) > 0}
                                fallback={<div class="text-caption opacity-60">此刻无「该压缩」的确定事实（缓存还热 / 窗口未满）</div>}
                            >
                                <div class="text-caption text-warning">
                                    <For each={auto()?.reasons ?? []}>{(r) => <div>⚠ {r}</div>}</For>
                                </div>
                            </Show>

                            <button
                                class="btn btn-primary btn-xs w-full"
                                aria-label="立即压缩"
                                disabled={busy() || autoBusy()}
                                onClick={() => void apply()}
                            >
                                {busy() ? "压缩中…" : "立即压缩（历史保留）"}
                            </button>
                        </div>

                        {/* 压缩后估算：压缩前 / 压缩后 / 预估节省 */}
                        <Block title="压缩后估算">
                            <table class="table table-xs w-full">
                                <thead>
                                    <tr class="text-caption">
                                        <th>被压缩的历史消息</th>
                                        <th class="text-right">压缩前</th>
                                        <th class="text-right">压缩后</th>
                                        <th class="text-right">预估节省</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={pv()?.facts ?? []}>
                                        {(r, i) => (
                                            <FactRow
                                                row={r}
                                                isTotal={r.key === "total"}
                                                isLast={i() === (pv()?.facts.length ?? 1) - 1}
                                            />
                                        )}
                                    </For>
                                </tbody>
                            </table>
                            <div class="mt-1 text-caption opacity-60">
                                token 按字节/4 估算，仅用于对比（不进计费）；金额差按当前模型非缓存输入单价。
                            </div>
                        </Block>
                    </div>

                    {/* ── 右栏：请求 YAML diff ─────────────────────────── */}
                    <div class="grow flex flex-col overflow-hidden">
                        <div class="px-3 py-1.5 border-b flex items-center gap-3 shrink-0 text-caption">
                            <div class="join">
                                <button
                                    class={`btn btn-xs join-item ${!sideBySide() ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setSideBySide(false)}
                                >
                                    统一 diff
                                </button>
                                <button
                                    class={`btn btn-xs join-item ${sideBySide() ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setSideBySide(true)}
                                >
                                    并排
                                </button>
                            </div>
                            <label class="flex items-center gap-1 cursor-pointer">
                                <input
                                    type="checkbox"
                                    class="toggle toggle-xs"
                                    aria-label="只看差异"
                                    checked={onlyDiff()}
                                    onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
                                />
                                只看差异
                            </label>
                            <button
                                class="btn btn-ghost btn-xs"
                                aria-label="逐级展开"
                                onClick={nextLevel}
                            >
                                展开 {curLevel()}/{foldLevels()}
                            </button>
                            <span class="opacity-50 ml-auto">请求结构 YAML（base vs mod）</span>
                        </div>

                        <div class="overflow-auto grow p-2 text-caption font-mono leading-[1.5]" data-compact-preview>
                            <Show when={!sideBySide()} fallback={
                                <table class="w-full border-collapse">
                                    <tbody>
                                        <For each={renderRows()}>
                                            {({ i, row }) => (
                                                <tr class={row.t === "add" ? "bg-success/10" : row.t === "del" || row.t === "change" ? "bg-error/10" : ""}>
                                                    <td class="align-top whitespace-pre-wrap break-all w-1/2 pr-2 border-r border-base-300">
                                                        <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                        <span class={row.t === "del" || row.t === "change" ? "text-error" : ""}>
                                                            {row.left ? INDENT.repeat(row.left.indent) + row.left.text : ""}
                                                        </span>
                                                        <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                                    </td>
                                                    <td class="align-top whitespace-pre-wrap break-all pl-2">
                                                        <span class={row.t === "add" || row.t === "change" ? "text-success" : ""}>
                                                            {row.right ? INDENT.repeat(row.right.indent) + row.right.text : ""}
                                                        </span>
                                                    </td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            }>
                                <For each={renderRows()}>
                                    {({ i, row }) => (
                                        <Show
                                            when={row.t !== "change"}
                                            fallback={
                                                <>
                                                    <div data-diff="del" class="bg-error/10 text-error">
                                                        <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                        <span class="opacity-40 select-none">- </span>
                                                        <span class="whitespace-pre-wrap break-all">
                                                            {INDENT.repeat(row.left?.indent ?? row.indent) + (row.left?.text ?? "")}
                                                        </span>
                                                        <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                                    </div>
                                                    <div data-diff="add" class="bg-success/10 text-success">
                                                        <span class="inline-block w-3" />
                                                        <span class="opacity-40 select-none">+ </span>
                                                        <span class="whitespace-pre-wrap break-all">
                                                            {INDENT.repeat(row.right?.indent ?? row.indent) + (row.right?.text ?? "")}
                                                        </span>
                                                    </div>
                                                </>
                                            }
                                        >
                                            <div
                                                data-diff={row.t}
                                                class={
                                                    row.t === "add"
                                                        ? "bg-success/10 text-success"
                                                        : row.t === "del"
                                                          ? "bg-error/10 text-error"
                                                          : ""
                                                }
                                            >
                                                <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                <span class="opacity-40 select-none">{row.t === "add" ? "+" : row.t === "del" ? "-" : " "} </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.indent) + (row.right?.text ?? row.left?.text ?? "")}
                                                </span>
                                                <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                            </div>
                                        </Show>
                                    )}
                                </For>
                            </Show>
                            <Show when={renderRows().length === 0}>
                                <div class="p-4 opacity-60">无差异（当前参数与生效请求一致）</div>
                            </Show>
                        </div>
                    </div>
                </div>

                <div class="px-4 py-2 border-t flex items-center justify-between gap-2 shrink-0">
                    <Show when={err()}>
                        <span class="text-caption text-error">{err()}</span>
                    </Show>
                    <div class="flex-1" />
                    <button class="btn btn-xs" onClick={props.onClose}>
                        取消
                    </button>
                    <button
                        class="btn btn-primary btn-xs"
                        aria-label="执行压缩"
                        disabled={busy()}
                        onClick={() => void apply()}
                    >
                        {busy() ? "压缩中…" : "压缩（历史保留）"}
                    </button>
                </div>
                {/* 底边拖拽把手：调整抽屉高度（对齐 token 窗口用量抽屉的形态） */}
                <div
                    class="h-1.5 shrink-0 cursor-row-resize bg-base-300 hover:bg-primary/50 active:bg-primary"
                    title="拖动调整高度"
                    aria-label="拖动调整高度"
                    onMouseDown={startResize}
                />
            </div>
        </div>
    );
}

/**
 * 折叠箭头（可折叠行才画；**只画箭头**，变更点由行尾的 ChangeMark 承担）。
 * 折叠且有内含变更时箭头染警示色（提示「里面还有东西，展开看看」）；展开后恢复常态。
 */
function FoldToggle(props: {
    i: number;
    row: YamlDiffRow;
    collapsed: boolean;
    changes?: { add: number; del: number };
    onToggle: (i: number) => void;
}) {
    if (!props.row.foldable) return <span class="inline-block w-3" />;
    const warn = props.collapsed && hasOwnChange(props.changes);
    return (
        <button
            class={`inline-block w-3 text-left select-none hover:opacity-100 ${warn ? "text-warning" : "opacity-60"}`}
            aria-label={props.collapsed ? "展开节点" : "折叠节点"}
            onClick={() => props.onToggle(props.i)}
        >
            {props.collapsed ? "▸" : "▾"}
        </button>
    );
}

/**
 * 行尾变更点：**只在节点折叠时**显示（展开后不用标注 —— 内容已可见），
 * 放行尾而非行首，避免插在缩进前破坏 YAML 的层级视觉。
 */
function ChangeMark(props: { collapsed: boolean; changes?: { add: number; del: number } }) {
    const c = props.changes;
    const show = () => props.collapsed && hasOwnChange(c);
    return (
        <Show when={show()}>
            <span
                class="ml-2 text-warning select-none"
                title={`内含变更：删 ${c!.del} / 增 ${c!.add} 行（展开查看）`}
            >
                ●{" "}
                {c!.del > 0 ? `-${c!.del}` : ""}
                {c!.del > 0 && c!.add > 0 ? " " : ""}
                {c!.add > 0 ? `+${c!.add}` : ""}
            </span>
        </Show>
    );
}


// ─── 历史会话（代列表 + 只读查看 + 撤销）────────────────

interface GenRow {
    seq: number;
    fromTurnId: string | null;
    startedAt: string | null;
    current: boolean;
    turns: number;
    messages: number;
    bytes: number;
    totalTokens: number;
    cost: number | null;
    compactId: string | null;
    /** 谁压的（ui / cli / auto）与为什么压 —— 历史列表要能看出理由（用户 2026-10-06） */
    by?: "ui" | "cli" | "auto";
    trigger?: string;
}

export function GenerationsPanel(props: { uri: string; onClose: () => void }) {
    const [gens, { refetch }] = createResource(() => props.uri, async (u) => (await localChatStore.generations(u)) as GenRow[]);
    const [openSeq, setOpenSeq] = createSignal<number | null>(null);
    const [opsView] = createResource(openSeq, async (seq) => (seq == null ? [] : await localChatStore.generationOps(props.uri, seq)));
    const [busy, setBusy] = createSignal(false);
    const [maximized, setMaximized] = createSignal(false);

    const undo = async (ref: string) => {
        setBusy(true);
        try {
            await localChatStore.undoCompact(props.uri, ref);
            await refetch();
        } finally {
            setBusy(false);
        }
    };

    const asText = (ops: { op: string; kind?: string; id: string }[]) =>
        ops
            .filter((o) => o.op === "delta")
            .map((o) => (o as unknown as { fields?: { content?: string } }).fields?.content ?? "")
            .filter(Boolean)
            .join("\n");

    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div
                class={`bg-base-100 rounded-xl w-full flex flex-col ${maximized() ? "max-w-[96vw] h-[92vh]" : "max-w-2xl max-h-[90vh]"}`}
            >
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">历史会话（{gens()?.length ?? 0} 代）</div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>
                <div class="overflow-auto grow">
                    <Show when={openSeq() == null} fallback={
                        <div class="p-3">
                            <button class="btn btn-ghost btn-xs mb-2" onClick={() => setOpenSeq(null)}>
                                ← 返回列表
                            </button>
                            <div class="text-caption opacity-60 mb-1">只读 · 旧会话内容（不可续聊）</div>
                            <pre class="whitespace-pre-wrap text-caption font-mono opacity-80">{asText(opsView() ?? [])}</pre>
                        </div>
                    }>
                        <table class="table table-xs">
                            <thead>
                                <tr>
                                    <th>代</th>
                                    <th>起始</th>
                                    <th class="text-right">轮</th>
                                    <th class="text-right">消息</th>
                                    <th class="text-right">token</th>
                                    <th class="text-right">金额</th>
                                    <th>方式 / 理由</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                <For each={gens()}>
                                    {(g) => (
                                        <tr>
                                            <td>
                                                第 {g.seq} 代 {g.current ? <span class="badge badge-primary badge-xs">当前</span> : null}
                                            </td>
                                            <td class="opacity-70">{g.startedAt ? new Date(g.startedAt).toLocaleString() : "—"}</td>
                                            <td class="text-right tabular-nums">{g.turns}</td>
                                            <td class="text-right tabular-nums">{g.messages}</td>
                                            <td class="text-right tabular-nums">{g.totalTokens.toLocaleString()}</td>
                                            <td class="text-right tabular-nums">{g.cost == null ? "—" : `$${g.cost.toFixed(4)}`}</td>
                                            <td class="opacity-80 text-caption">
                                                <Show when={g.by} fallback={<span class="opacity-40">—</span>}>
                                                    <span class="badge badge-xs" classList={{ "badge-info": g.by === "auto" }}>
                                                        {g.by === "auto" ? "自动" : g.by === "ui" ? "界面" : "命令行"}
                                                    </span>
                                                    <span class="ml-1">{triggerText(g.trigger)}</span>
                                                </Show>
                                            </td>
                                            <td class="text-right">
                                                <button class="btn btn-ghost btn-xs" onClick={() => setOpenSeq(g.seq)}>
                                                    查看
                                                </button>
                                                <Show when={!g.current && g.compactId}>
                                                    <button
                                                        class="btn btn-ghost btn-xs text-warning"
                                                        disabled={busy()}
                                                        title="撤销这次压缩（历史原地恢复，可审计）"
                                                        onClick={() => void undo(g.compactId!)}
                                                    >
                                                        撤销
                                                    </button>
                                                </Show>
                                            </td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>
            </div>
        </div>
    );
}

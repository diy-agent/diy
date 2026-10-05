/**
 * CompactSessionPanel — 压缩会话上下文（清零 → 硬切换新 session 的 UI）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩（本面板）：只改「发给模型的上下文」—— 保留最近 N 轮 + 可选裁工具输出；
 *     **不删任何历史**，旧内容仍在会话日志里、可查（历史代）、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 与本面板是两回事，别混。
 *
 * 布局（2026-10-05 定稿）：**左参数 + 右预览**，一眼对照。
 *   · base = 当前生效请求（requestView，打开面板取一次）
 *   · mod  = 改参数后请求（compactPreview 随参数刷新）
 *   · 右栏把两者渲染成 YAML 行、做行级 diff（增删变色、可折叠、可只看差异、可并排）
 *   · 左栏底部「事实表」= base↔mod 分层 token 与金额差（旧值 / 新值 / 省 cost）
 */

import { createSignal, createResource, For, Show, createMemo, onMount, onCleanup } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import {
    DEFAULT_COMPACT_POLICY,
    DEFAULT_HEADTAIL,
    normalizePolicy,
    type CompactPolicy,
    type ToolOutputMode,
} from "../../shared/context/compaction";
import {
    defaultCollapsed,
    diffYamlRows,
    toYamlLines,
    visibleDiffRows,
    type YamlDiffRow,
} from "../../shared/yaml-lines";
import { requestViewYaml, type LayerRow, type RequestView } from "../../shared/context/request-view";

const INDENT = "  ";

/** 「事实表」一行：旧值 / 新值 / 省 cost */
function FactRow(props: { row: LayerRow }) {
    const saved = () => props.row.costDelta < 0;
    const zero = () => Math.abs(props.row.costDelta) < 1e-9;
    return (
        <tr title={props.row.label}>
            <td class="pr-2 whitespace-nowrap">{props.row.label.split(" — ")[0]}</td>
            <td class="text-right tabular-nums opacity-70">{props.row.oldTokens.toLocaleString()}</td>
            <td class="text-right tabular-nums">{props.row.newTokens.toLocaleString()}</td>
            <td class={`text-right tabular-nums ${saved() ? "text-success" : zero() ? "opacity-50" : "text-error"}`}>
                {zero() ? "0" : `${props.row.costDelta < 0 ? "−" : "+"}$${Math.abs(props.row.costDelta).toFixed(4)}`}
            </td>
        </tr>
    );
}

export function CompactSessionPanel(props: { uri: string; onClose: () => void }) {
    const [pol, setPolRaw] = createSignal<CompactPolicy>({ ...DEFAULT_COMPACT_POLICY, headtail: { ...DEFAULT_HEADTAIL } });
    const setPol = (p: Partial<CompactPolicy>) => setPolRaw(normalizePolicy({ ...pol(), ...p }));
    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);

    // 右栏视图控制
    const [sideBySide, setSideBySide] = createSignal(false);
    const [onlyDiff, setOnlyDiff] = createSignal(true);
    const [forceExpand, setForceExpand] = createSignal(false);
    const [localCollapsed, setLocalCollapsed] = createSignal<Set<number>>(new Set());

    const turnCount = () => localChatStore.trees.length;

    // base 请求（打开面板取一次，参数变化不重取）
    const [base] = createResource(() => props.uri, (u) => localChatStore.requestView(u) as Promise<RequestView>);

    // 预览（只算不写）：策略变化即重算（返回 mod 请求 + 事实表）
    const [pv] = createResource(
        () => ({ uri: props.uri, p: pol() }),
        (k) => localChatStore.compactPreview(k.uri, k.p) as Promise<{
            before: { bytes: number };
            after: { bytes: number };
            keptTurns: number;
            droppedTurns: number;
            facts: LayerRow[];
            modRequest: RequestView;
        }>,
    );

    // YAML 行 + diff
    const baseLines = createMemo(() => (base() ? toYamlLines(requestViewYaml(base()!)) : []));
    const modLines = createMemo(() => (pv() ? toYamlLines(requestViewYaml(pv()!.modRequest)) : []));
    const rows = createMemo<YamlDiffRow[]>(() => diffYamlRows(baseLines(), modLines()));

    // 折叠态：默认折叠「不含变化」的节；「全展开」清空；用户点击切换
    const collapsed = createMemo<Set<number>>(() => {
        if (forceExpand()) return new Set();
        const local = localCollapsed();
        return local.size > 0 ? local : defaultCollapsed(rows());
    });

    const shownIndexes = createMemo(() => visibleDiffRows(rows(), collapsed()));
    const renderRows = createMemo(() => {
        const idx = shownIndexes();
        const all = rows();
        return idx.map((i) => ({ i, row: all[i]! })).filter(({ row }) => !onlyDiff() || row.t !== "same");
    });

    const toggleFold = (i: number) => {
        const cur = new Set(collapsed());
        if (cur.has(i)) cur.delete(i);
        else cur.add(i);
        setForceExpand(false);
        setLocalCollapsed(cur);
    };

    const apply = async () => {
        setBusy(true);
        setErr(null);
        try {
            await localChatStore.compact(props.uri, pol());
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

    // 概要：当前 → 压缩后（估算 token）
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
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div class="bg-base-100 rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col">
                <div class="px-4 py-2.5 border-b flex items-center justify-between shrink-0">
                    <div class="font-bold text-title">压缩会话上下文</div>
                    <div class="text-caption opacity-70">
                        当前 {estTok(pv()?.before.bytes ?? 0).toLocaleString()} tok → 压缩后{" "}
                        {estTok(pv()?.after.bytes ?? 0).toLocaleString()} tok{" "}
                        <span class="text-success">(-{ratio()}%)</span>
                        <span class="opacity-60">　删 {diffCounts().del} / 增 {diffCounts().add} 行</span>
                    </div>
                    <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                        ✕
                    </button>
                </div>

                <div class="flex grow overflow-hidden">
                    {/* ── 左栏：参数 + 事实表 ─────────────────────────── */}
                    <div class="w-[340px] shrink-0 border-r overflow-auto p-3 space-y-4">
                        <section>
                            <div class="text-body font-semibold mb-1.5">① 保留范围</div>
                            <input
                                type="range"
                                min="0"
                                max={Math.max(1, turnCount())}
                                step="1"
                                class="range range-primary range-sm w-full"
                                value={pol().keepTurns}
                                aria-label="保留最近轮数"
                                onInput={(e) => setPol({ keepTurns: Number(e.currentTarget.value) })}
                            />
                            <div class="text-caption opacity-80">
                                保留最近 <b>{pol().keepTurns}</b> 轮（共 {turnCount()} 轮）
                                {pol().keepTurns === 0 ? " · 全部清零" : ""}
                            </div>
                        </section>

                        <section>
                            <div class="text-body font-semibold mb-1.5">② 工具输出（只对保留部分生效）</div>
                            <div class="flex flex-col gap-1 text-body">
                                {(["asis", "headtail", "callpath"] as ToolOutputMode[]).map((m) => (
                                    <label class="flex items-center gap-1.5 cursor-pointer">
                                        <input
                                            type="radio"
                                            class="radio radio-xs radio-primary"
                                            checked={pol().toolOutput === m}
                                            onChange={() => setPol({ toolOutput: m })}
                                        />
                                        <span>
                                            {m === "asis"
                                                ? "原样（不裁）"
                                                : m === "headtail"
                                                  ? "头尾裁剪（保留头尾，中间省略）"
                                                  : "只留调用+路径（整段换成原文路径）"}
                                        </span>
                                    </label>
                                ))}
                            </div>
                            <Show when={pol().toolOutput === "headtail"}>
                                <div class="mt-2 flex items-center gap-1.5 text-caption">
                                    <span>保留 前</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-14"
                                        value={pol().headtail.headLines}
                                        aria-label="保留头部行数"
                                        onInput={(e) => setPol({ headtail: { ...pol().headtail, headLines: Number(e.currentTarget.value) } })}
                                    />
                                    <span>行 后</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-14"
                                        value={pol().headtail.tailLines}
                                        aria-label="保留尾部行数"
                                        onInput={(e) => setPol({ headtail: { ...pol().headtail, tailLines: Number(e.currentTarget.value) } })}
                                    />
                                    <span>行</span>
                                </div>
                                <div class="mt-1 text-caption opacity-60">
                                    ⓘ 超过 {pol().headtail.headLines + pol().headtail.tailLines} 行的输出才裁剪；裁掉的原文落盘可寻回
                                </div>
                            </Show>
                            <Show when={pol().toolOutput === "callpath"}>
                                <div class="mt-1 text-caption opacity-60">整段输出换成一行指向原文的提示，模型可按路径回取。</div>
                            </Show>
                        </section>

                        <section>
                            <label class="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    class="checkbox checkbox-xs checkbox-primary mt-0.5"
                                    checked={pol().summary}
                                    onChange={(e) => setPol({ summary: e.currentTarget.checked })}
                                />
                                <span class="text-body">
                                    ③ 计算历史摘要并带进新会话
                                    <span class="block text-caption opacity-60">
                                        可选（额外调一次模型）。清零只丢会话历史，任务记忆仍在任务正文里。
                                    </span>
                                </span>
                            </label>
                        </section>

                        {/* 事实表：base ↔ mod 差异（旧值 / 新值 / 省 cost） */}
                        <section>
                            <div class="text-body font-semibold mb-1.5">事实（当前请求 → 改参数后）</div>
                            <table class="table table-xs w-full">
                                <thead>
                                    <tr class="text-caption">
                                        <th>层级</th>
                                        <th class="text-right">旧值</th>
                                        <th class="text-right">新值</th>
                                        <th class="text-right">省 cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={pv()?.facts ?? []}>{(r) => <FactRow row={r} />}</For>
                                </tbody>
                            </table>
                            <div class="mt-1 text-caption opacity-60">
                                token 按字节/4 估算，仅用于对比（不进计费）；金额差按当前模型非缓存输入单价。
                            </div>
                            <div class="mt-1 text-caption opacity-80">
                                保留 {pv()?.keptTurns ?? pol().keepTurns} 轮 · 不再重发 {pv()?.droppedTurns ?? 0} 轮 · 旧历史原地保留（可在「历史会话」查，可撤销）
                            </div>
                        </section>
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
                                    class="checkbox checkbox-xs"
                                    checked={onlyDiff()}
                                    onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
                                />
                                只看差异
                            </label>
                            <button
                                class="btn btn-ghost btn-xs"
                                onClick={() => {
                                    setForceExpand(true);
                                    setLocalCollapsed(new Set<number>());
                                }}
                            >
                                全部展开
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
                                                        <FoldToggle i={i} row={row} collapsed={collapsed()} onToggle={toggleFold} side="left" />
                                                        <span class={row.t === "del" || row.t === "change" ? "text-error" : ""}>
                                                            {row.left ? INDENT.repeat(row.left.indent) + row.left.text : ""}
                                                        </span>
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
                                                        <FoldToggle i={i} row={row} collapsed={collapsed()} onToggle={toggleFold} side="left" />
                                                        <span class="opacity-40 select-none">- </span>
                                                        <span class="whitespace-pre-wrap break-all">
                                                            {INDENT.repeat(row.left?.indent ?? row.indent) + (row.left?.text ?? "")}
                                                        </span>
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
                                                <FoldToggle i={i} row={row} collapsed={collapsed()} onToggle={toggleFold} side="left" />
                                                <span class="opacity-40 select-none">{row.t === "add" ? "+" : row.t === "del" ? "-" : " "} </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.indent) + (row.right?.text ?? row.left?.text ?? "")}
                                                </span>
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
            </div>
        </div>
    );
}

/** 折叠箭头（可折叠行才画） */
function FoldToggle(props: {
    i: number;
    row: YamlDiffRow;
    collapsed: ReadonlySet<number>;
    onToggle: (i: number) => void;
    side: "left" | "right";
}) {
    return (
        <Show when={props.row.foldable} fallback={<span class="inline-block w-3" />}>
            <button
                class="inline-block w-3 text-left opacity-60 hover:opacity-100 select-none"
                aria-label={props.collapsed.has(props.i) ? "展开" : "折叠"}
                onClick={() => props.onToggle(props.i)}
            >
                {props.collapsed.has(props.i) ? "▸" : "▾"}
            </button>
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
}

export function GenerationsPanel(props: { uri: string; onClose: () => void }) {
    const [gens, { refetch }] = createResource(() => props.uri, async (u) => (await localChatStore.generations(u)) as GenRow[]);
    const [openSeq, setOpenSeq] = createSignal<number | null>(null);
    const [opsView] = createResource(openSeq, async (seq) => (seq == null ? [] : await localChatStore.generationOps(props.uri, seq)));
    const [busy, setBusy] = createSignal(false);

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
            <div class="bg-base-100 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">历史会话（{gens()?.length ?? 0} 代）</div>
                    <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                        ✕
                    </button>
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

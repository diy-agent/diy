/**
 * CompactSessionPanel — 压缩会话上下文（清零 → 硬切换新 session 的 UI）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩（本面板）：只改「发给模型的上下文」—— 保留最近 N 轮 + 可选裁工具输出；
 *     **不删任何历史**，旧内容仍在会话日志里、可查（历史代）、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 与本面板是两回事，别混。
 *
 * 为什么在这里现算预览、不走 RPC：拉滑条要实时看到「保留/丢弃/首屏估算」的变化，
 * 每动一下打一次主进程往返既慢又浪费。预览与真发共用同一份纯函数
 * （shared/context/compaction + local-blocks.blocksToMessages），所以「预览看到的 = 真压出来的」。
 */

import { createSignal, createResource, For, Show, createMemo, onMount, onCleanup } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { BlockStore, blocksToMessages, type Op, type BlockNode } from "../../main/services/local-blocks";
import { lineDiff } from "../../shared/line-diff";
import {
    DEFAULT_COMPACT_POLICY,
    DEFAULT_HEADTAIL,
    estimateTokens,
    fmtBytes,
    listTurnIds,
    makeDeliveryTransform,
    normalizePolicy,
    sliceOpsFromTurn,
    type CompactPolicy,
    type ToolOutputMode,
} from "../../shared/context/compaction";

/** 工具原文相对路径（与 main 的 toolOutRelPath 同形；renderer 不碰文件系统，只要字符串一致） */
const origPathOf = (id: string) => `local/toolout/${id.replace(/[^\w.-]+/g, "_")}.txt`;

/** ops → 投递文本（renderer 预览用；与 main 真发同一份纯函数链） */
function projectText(ops: Op[], policy: CompactPolicy, keptFromTurnId: string | null): string {
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const t = makeDeliveryTransform(policy, keptFromTurnId, origPathOf);
    const msgs = blocksToMessages(store, { sinceTurnId: t.sinceTurnId, transformToolOutput: t.transformToolOutput });
    return msgs.map((m) => JSON.stringify(m)).join("\n");
}

/** 一个可直接渲染的「事实」数字行 */
function Fact(props: { label: string; value: string; hint?: string }) {
    return (
        <div class="flex items-baseline justify-between gap-3 text-caption">
            <span class="opacity-60">{props.label}</span>
            <span class="tabular-nums" title={props.hint}>
                {props.value}
            </span>
        </div>
    );
}

export function CompactSessionPanel(props: { uri: string; onClose: () => void }) {
    const [pol, setPolRaw] = createSignal<CompactPolicy>({ ...DEFAULT_COMPACT_POLICY, headtail: { ...DEFAULT_HEADTAIL } });
    const setPol = (p: Partial<CompactPolicy>) => setPolRaw(normalizePolicy({ ...pol(), ...p }));
    const [previewing, setPreviewing] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);

    // 轮数：当前会话视图的 root 节点数（压缩后的当前会话）
    const turnCount = () => localChatStore.trees.length;

    // 预览（只算不写）：策略变化即重算
    const [pv] = createResource(
        () => ({ uri: props.uri, p: pol() }),
        async (k) => localChatStore.compactPreview(k.uri, k.p),
    );

    // 全量 ops（预览 diff 需要边界前的旧内容，而 store.trees 只是当前会话）
    const [allOps] = createResource(() => props.uri, async (u) => {
        // history 返回的是**当前代**的 ops；预览 diff 要的是「当前会话」文本，
        // 与真发口径一致 —— 故直接用当前代 ops 即可（压缩后当前代已缩）。
        return (await import("../lib/rpc")).diyService.diy.agent.local.history({ taskUri: u }) as Promise<Op[]>;
    });

    const keptFromTurnId = createMemo(() => {
        const ids = listTurnIds(allOps() ?? []);
        const keep = Math.min(pol().keepTurns, ids.length);
        return keep > 0 ? ids[ids.length - keep]! : null;
    });

    const beforeText = createMemo(() => {
        const ops = allOps();
        return ops ? projectText(ops, { ...pol(), toolOutput: "asis" }, null) : "";
    });
    const afterText = createMemo(() => {
        const ops = allOps();
        return ops ? projectText(ops, pol(), keptFromTurnId()) : "";
    });
    const diff = createMemo(() => lineDiff(beforeText(), afterText()));
    const diffCounts = createMemo(() => {
        let add = 0, del = 0;
        for (const d of diff()) {
            if (d.t === "+") add++;
            else if (d.t === "-") del++;
        }
        return { add, del };
    });

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
            if (previewing()) setPreviewing(false);
            else props.onClose();
        }
    };
    onMount(() => document.addEventListener("keydown", onKey, true));
    onCleanup(() => document.removeEventListener("keydown", onKey, true));

    const p = () => pv();
    const ratio = () => {
        const b = p()?.before.estTokens ?? 0;
        const a = p()?.after.estTokens ?? 0;
        return b > 0 ? Math.round((1 - a / b) * 100) : 0;
    };

    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div class="bg-base-100 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">
                        {previewing() ? "压缩预览（当前会话 → 压缩后）" : "压缩会话上下文"}
                    </div>
                    <button class="btn btn-ghost btn-xs" onClick={() => (previewing() ? setPreviewing(false) : props.onClose())}>
                        {previewing() ? "← 返回设置" : "✕"}
                    </button>
                </div>

                <Show when={!previewing()}>
                    <div class="px-4 py-3 overflow-auto grow space-y-4">
                        {/* ① 保留范围 */}
                        <section>
                            <div class="text-body font-semibold mb-1.5">① 保留范围</div>
                            <div class="flex items-center gap-3">
                                <input
                                    type="range"
                                    min="0"
                                    max={Math.max(1, turnCount())}
                                    step="1"
                                    class="range range-primary range-sm grow"
                                    value={pol().keepTurns}
                                    aria-label="保留最近轮数"
                                    onInput={(e) => setPol({ keepTurns: Number(e.currentTarget.value) })}
                                />
                                <span class="tabular-nums w-40 shrink-0 text-caption">
                                    保留最近 {pol().keepTurns} 轮（共 {turnCount()} 轮）
                                    {pol().keepTurns === 0 ? " · 全部清零" : ""}
                                </span>
                            </div>
                        </section>

                        {/* ② 工具输出 */}
                        <section>
                            <div class="text-body font-semibold mb-1.5">② 工具输出（只对「保留部分」生效）</div>
                            <div class="flex flex-wrap gap-x-4 gap-y-1 text-body">
                                {(["asis", "headtail", "callpath"] as ToolOutputMode[]).map((m) => (
                                    <label class="flex items-center gap-1.5 cursor-pointer">
                                        <input
                                            type="radio"
                                            class="radio radio-xs radio-primary"
                                            checked={pol().toolOutput === m}
                                            onChange={() => setPol({ toolOutput: m })}
                                        />
                                        {m === "asis" ? "原样" : m === "headtail" ? "头尾裁剪" : "只留调用+路径"}
                                    </label>
                                ))}
                            </div>
                            <Show when={pol().toolOutput === "headtail"}>
                                <div class="mt-2 flex flex-wrap items-center gap-2 text-caption">
                                    <span>超过</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-16"
                                        value={pol().headtail.triggerLines}
                                        onInput={(e) => setPol({ headtail: { ...pol().headtail, triggerLines: Number(e.currentTarget.value) } })}
                                    />
                                    <span>行才裁，保留 前</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-16"
                                        value={pol().headtail.headLines}
                                        onInput={(e) => setPol({ headtail: { ...pol().headtail, headLines: Number(e.currentTarget.value) } })}
                                    />
                                    <span>行 后</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-16"
                                        value={pol().headtail.tailLines}
                                        onInput={(e) => setPol({ headtail: { ...pol().headtail, tailLines: Number(e.currentTarget.value) } })}
                                    />
                                    <span>行</span>
                                </div>
                                {/* 真实 1,842 行 rg 输出范例 */}
                                <div class="mt-2 rounded-box border border-base-300 bg-base-200/40 p-2 text-caption font-mono leading-relaxed">
                                    <div class="opacity-60">原输出 1,842 行 / 96 KB → 裁后 50 行 / 2.6 KB（↓97%）</div>
                                    <div class="opacity-50">模型看到：（前 40 行原样）…</div>
                                    <div class="text-warning">
                                        [... 中间省略 1,792 行 / 93 KB，完整输出见 local/toolout/&lt;id&gt;.txt ...]
                                    </div>
                                    <div class="opacity-50">（后 10 行原样）…</div>
                                </div>
                                <div class="mt-1 text-caption opacity-60">ⓘ 86% 的历史输出不到 50 行，不受影响</div>
                            </Show>
                            <Show when={pol().toolOutput === "callpath"}>
                                <div class="mt-1 text-caption opacity-60">
                                    整段输出换成一行指向原文的提示；完整输出落盘，模型可按路径回取。
                                </div>
                            </Show>
                        </section>

                        {/* ③ 历史摘要 */}
                        <section>
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    class="checkbox checkbox-xs checkbox-primary"
                                    checked={pol().summary}
                                    onChange={(e) => setPol({ summary: e.currentTarget.checked })}
                                />
                                <span class="text-body">③ 计算历史摘要并带进新会话（含关键文件清单）</span>
                            </label>
                            <div class="mt-1 text-caption opacity-60">
                                可选增强：会额外调一次模型（花钱、慢一拍）。不清零时任务记忆仍在任务正文里，
                                清零 ≠ 失忆（只丢会话历史，system/runtime 两块不动）。
                            </div>
                        </section>

                        {/* 事实（只列数，不预测好坏 —— 用户 230#25 明确放弃效果评估） */}
                        <section class="rounded-box border border-base-300 bg-base-200/30 p-3 space-y-1">
                            <div class="text-caption font-semibold opacity-70 mb-1">事实</div>
                            <Show when={p()} fallback={<div class="text-caption opacity-60">计算中…</div>}>
                                <Fact
                                    label="保留"
                                    value={`${p()!.keptTurns} 轮 · ${p()!.after.messages} 条 · ${fmtBytes(p()!.after.bytes)}`}
                                />
                                <Fact
                                    label="不再重发"
                                    value={`${p()!.droppedTurns} 轮 · ${p()!.before.messages - p()!.after.messages} 条 · ${fmtBytes(Math.max(0, p()!.before.bytes - p()!.after.bytes))}`}
                                />
                                <Fact
                                    label="新会话首屏估算"
                                    value={`~${estimateTokens(p()!.after.bytes).toLocaleString()}（现 ${estimateTokens(p()!.before.bytes).toLocaleString()}）`}
                                    hint="按字节/4 粗估，仅用于对比，不用于计费"
                                />
                                <Show when={p()!.rebuildCost !== undefined}>
                                    <Fact
                                        label="一次性缓存重建"
                                        value={`≈$${(p()!.rebuildCost ?? 0).toFixed(4)}`}
                                        hint="保留部分按 (全价−缓存读) 重读一次；纯账，不是预测"
                                    />
                                </Show>
                                <Show when={p()!.rates}>
                                    <Fact
                                        label="单价依据"
                                        value={`k=${(p()!.rates!.k).toFixed(0)}×（${p()!.rates!.provider ?? p()!.rates!.model ?? "?"}）`}
                                        hint="k = 全价 ÷ 缓存读；砍一半约需 (剩余/砍掉)×(k−1) 步回本"
                                    />
                                </Show>
                                <Show when={p()!.taxShare !== undefined}>
                                    <Fact label="税率（缓存读占总成本）" value={`${Math.round((p()!.taxShare ?? 0) * 100)}%`} />
                                </Show>
                                <Fact label="旧历史去向" value="原地保留（可在「历史会话」查，可撤销）" />
                            </Show>
                        </section>

                        <Show when={err()}>
                            <div class="text-caption text-error">{err()}</div>
                        </Show>
                    </div>

                    <div class="px-4 py-2 border-t flex justify-between items-center gap-2">
                        <button class="btn btn-ghost btn-xs" onClick={() => setPreviewing(true)}>
                            预览 diff
                        </button>
                        <div class="flex gap-2">
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
                </Show>

                {/* 预览页：diff */}
                <Show when={previewing()}>
                    <div class="px-4 py-2 border-b text-caption">
                        <span class="font-semibold">
                            当前 {estimateTokens(p()?.before.estTokens ? p()!.before.bytes : 0).toLocaleString()}
                            {" → "}
                            压缩后 {estimateTokens(p()?.after.bytes ?? 0).toLocaleString()}
                            {" "}
                            <span class="text-success">(-{ratio()}%)</span>
                        </span>
                        <span class="opacity-60">
                            {"　"}删 {diffCounts().del} 行 / 增 {diffCounts().add} 行
                        </span>
                    </div>
                    <div class="overflow-auto grow p-2 text-caption font-mono leading-relaxed">
                        <For each={diff()}>
                            {(d) => (
                                <div
                                    class={
                                        d.t === "+"
                                            ? "bg-success/10 text-success"
                                            : d.t === "-"
                                              ? "bg-error/10 text-error"
                                              : "opacity-70"
                                    }
                                >
                                    <span class="opacity-50 select-none">{d.t} </span>
                                    {d.s}
                                </div>
                            )}
                        </For>
                    </div>
                    <div class="px-4 py-2 border-t flex justify-end gap-2">
                        <button class="btn btn-xs" onClick={() => setPreviewing(false)}>
                            返回设置
                        </button>
                        <button class="btn btn-primary btn-xs" disabled={busy()} onClick={() => void apply()}>
                            {busy() ? "压缩中…" : "压缩（历史保留）"}
                        </button>
                    </div>
                </Show>
            </div>
        </div>
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

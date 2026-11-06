/**
 * KeptStepsBar — **手动拖压缩位置**（##519）。
 *
 * 一眼要看到的三件事（用户 2026-11-05 的口述需求）：
 *   ① 轴的长度 = **步数**，每步一格；格子的高低 = 这一步实测吃掉的 token（形状保留，拖动只切边界）
 *   ② 右边是保留（绿）、左边是被砍掉的（灰），最右 = 一步不砍
 *   ③ 手柄停在哪 =
 *      「保留最近 N 步」；松手就落盘，下一轮按它切
 *
 * ⚠️ 落盘口径是**token 预算**，不是步数：步数只是你手上的旋钮，main 侧用 `usage.jsonl` 的**实测增量**
 *   把它换算成「这 N 步一共多少 token」。因为一步可能是 370，也可能是 114k（实测），步数不是等价的 token。
 * ⚠️ 切点仍落在 **user 消息 + 轮首**（`resolveOpsReplay` 的 seek 锚点依赖轮首）：所以拖动条上标的
 *   「≈N 步」与实际落点可能差一两步 —— 界面必须把**实际落点**回显出来，不许只显示你拖到的位置。
 */
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { fmtTokens } from "@diy-agent/compaction/compact-when";

interface KeptStepRow {
    fromTail: number;
    turnId: string;
    step: number;
    ts: string;
    tokens: number;
    cumFromTail: number;
}

interface KeptStepsView {
    rows: KeptStepRow[];
    totalSteps: number;
    truncated: boolean;
    windowTokens: number | null;
    retainedTokens: number | null;
    defaultSteps: number | null;
    medianTokens: number | null;
}

export function KeptStepsBar(props: { uri: () => string; onApplied?: () => void }) {
    const [view, { refetch }] = createResource(props.uri, async (u) => (await localChatStore.compactLedger(u)) as KeptStepsView);
    /** `null` = 还没动过手柄（位置跟随默认 = 窗口 × 0.16 落在第几步） */
    const [keep, setKeep] = createSignal<number | null>(null);
    const [busy, setBusy] = createSignal(false);
    const [note, setNote] = createSignal<string | null>(null);

    const rows = (): KeptStepRow[] => view()?.rows ?? [];
    const total = (): number => rows().length;
    /** 手柄位置 = 保留几步（从最新往前数） */
    const kept = (): number => Math.min(total(), Math.max(0, Math.round(keep() ?? view()?.defaultSteps ?? total())));

    /** 保留这 N 步 ≈ 多少 token（超出无样本 ⇒ 用中位数兜底，且明说） */
    const keptTokens = (): { tokens: number; exact: boolean } => {
        const k = kept();
        if (k <= 0) return { tokens: 0, exact: true };
        const hit = rows().find((r) => r.fromTail === k);
        if (hit) return { tokens: hit.cumFromTail, exact: true };
        return { tokens: k * (view()?.medianTokens ?? 800), exact: false };
    };

    /** 当前生效边界落在第几步（无边界 = 全部保留） */
    const boundarySteps = (): number | null => {
        const r = view()?.retainedTokens;
        if (r == null) return null;
        return rows().find((x) => x.cumFromTail >= r)?.fromTail ?? total();
    };

    /** 每格高度：按 token 归一（保形），最矮 6% */
    const maxTokens = createMemo(() => Math.max(1, ...rows().map((r) => r.tokens)));

    function posToSteps(clientX: number, el: HTMLElement): number {
        const box = el.getBoundingClientRect();
        const f = 1 - (clientX - box.left) / Math.max(1, box.width);
        return Math.max(0, Math.min(total(), Math.round(f * total())));
    }

    let dragging = false;
    async function apply() {
        setBusy(true);
        setNote(null);
        try {
            const r = (await localChatStore.compactSetKept(props.uri(), kept())) as {
                applied: { dropped: number; keptMessages: number } | null;
            };
            if (r?.applied === null) {
                setNote("没有可压的（历史本来就不多 / 已到最早一轮）");
            } else if (r?.applied) {
                setNote(`已压：丢 ${r.applied.dropped} 条，留 ${r.applied.keptMessages} 条`);
            }
            await refetch();
            props.onApplied?.();
        } catch (e) {
            setNote(`失败：${(e as Error).message}`);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section class="border border-base-300 rounded-lg overflow-hidden min-w-0" data-kept-steps-bar>
            <div class="flex items-center gap-2 bg-base-300 px-2 py-1 text-body font-bold tracking-wide opacity-80">
                <span>压缩位置</span>
                <span class="font-normal opacity-60">拖到你想留的地方，松手即生效</span>
                <span class="ml-auto font-normal tabular-nums opacity-80" data-kept-readout>
                    <Show when={view()} fallback={<span class="opacity-50">读取中…</span>}>
                        保留最近 <b class="text-success">{kept()}</b> 步 · ≈ {fmtTokens(keptTokens().tokens)}
                        <Show when={!keptTokens().exact}>
                            <span class="opacity-60">（中位数估算）</span>
                        </Show>
                        <span class="opacity-50"> / 共 {total()} 步</span>
                    </Show>
                </span>
            </div>

            <Show when={view()} fallback={null}>
                <div class="px-2 pb-1.5 pt-2 space-y-1">
                    {/* 轴：每步一格，从新到旧 → 所以从右往左画 */}
                    <div
                        class="relative h-14 cursor-ew-resize select-none border border-base-300 rounded bg-base-200/40"
                        onPointerDown={(e) => {
                            dragging = true;
                            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                            setKeep(posToSteps(e.clientX, e.currentTarget as HTMLElement));
                        }}
                        onPointerMove={(e) => {
                            if (dragging) setKeep(posToSteps(e.clientX, e.currentTarget as HTMLElement));
                        }}
                        onPointerUp={(e) => {
                            dragging = false;
                            (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                            void apply();
                        }}
                    >
                        <div class="absolute inset-0 flex items-end gap-px px-px">
                            <For each={[...rows()].reverse()}>
                                {(r) => (
                                    <div
                                        class={`flex-1 min-w-0 rounded-t-sm ${r.fromTail <= kept() ? "bg-success/70" : "bg-base-content/15"}`}
                                        style={{ height: `${Math.max(6, (r.tokens / maxTokens()) * 100)}%` }}
                                        title={`第 ${r.step} 步 · ${fmtTokens(r.tokens)}`}
                                    />
                                )}
                            </For>
                        </div>
                        {/* 手柄 */}
                        <div
                            class="absolute top-0 bottom-0 w-0.5 bg-primary shadow"
                            style={{ left: `${(1 - kept() / Math.max(1, total())) * 100}%` }}
                        />
                        {/* 当前生效边界（虚线）：与手柄不同就说明还没应用 */}
                        <Show when={boundarySteps() !== null}>
                            <div
                                class="absolute top-0 bottom-0 border-l border-dashed border-warning/80"
                                style={{ left: `${(1 - (boundarySteps() ?? 0) / Math.max(1, total())) * 100}%` }}
                                title="当前生效的压缩边界"
                            />
                        </Show>
                    </div>

                    <div class="flex items-center gap-3 text-caption opacity-70">
                        <span>← 更早（砍掉）</span>
                        <span class="ml-auto">最近一步 →</span>
                    </div>

                    <Show when={kept() === 0}>
                        <div class="text-caption text-warning">
                            ⚠ 0 步 = 历史全清（任务正文 / 规则 / 工具仍在，不算丢了会话）。松手后下一轮首个请求全价重算。
                        </div>
                    </Show>
                    <Show when={view()?.truncated}>
                        <div class="text-caption opacity-50">只加载了最近 {total()} 步（更早的仍在盘上，未画出）</div>
                    </Show>
                    <Show when={boundarySteps() !== null}>
                        <div class="text-caption opacity-60" data-kept-boundary>
                            当前生效：保留最近 <b>{boundarySteps()}</b> 步（虚线）。手柄与虚线不一致 = 改完还没落盘。
                        </div>
                    </Show>
                    <Show when={note()}>
                        <div class="text-caption" data-kept-note>
                            {busy() ? "落盘中…" : note()}
                        </div>
                    </Show>
                </div>
            </Show>
        </section>
    );
}

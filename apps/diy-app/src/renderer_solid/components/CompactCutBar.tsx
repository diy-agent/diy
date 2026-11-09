/**
 * CompactCutBar — **手动压缩点**（##519）。
 *
 * 形态（用户 2026-11-05 定稿，见 `gen/compaction-drag/v9.html`）：
 *   ① 一条横向滑杆：左 = 保留 0 轮，右 = 保留全部；往右拖 = 多留
 *   ② 下面一张轮次表（轮1 在最上面 = 会话顺序），被压掉的整行划删除线
 *   ③ 表里一条**红色虚线 + 剪刀**就是压缩点：线上 = 会丢，线下 = 保留
 *   ④ 拖动时表格自动滚动，把压缩点尽量摆在可视区中间（内容装得下则不滚）
 *   ⑤ 第三行标**下一轮的价格估算**（压前 / 压后两个数，来自上一步价目）
 *
 * 为什么用 daisyUI 的 `range` 而不是 Material 的 `md-slider`：diy 的渲染层只有 daisyUI，
 * 为一个滑杆引入 `@material/web` 不划算（demo 里用 md-slider 只是为了看观感）。
 *
 * ⚠️ 落盘口径是**token 预算**：滑杆的「保留最近 N 轮」在 main 侧按实测增量换成 token
 *   （`compact.setKept`），切点仍吸附到轮首 —— 所以不影响 `resolveOpsReplay` 的 seek。
 */
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { fmtTokens } from "@diy-agent/compaction/compact-when";

interface RoundRow {
    turnId: string;
    label: string;
    title: string;
    tokens: number;
    kept: boolean;
}

interface RoundsView {
    rounds: RoundRow[];
    total: number;
    keptCount: number;
    truncated: boolean;
    windowTokens: number | null;
    usedTokens: number | null;
    retainedTokens: number | null;
    price: {
        nowUsd: number;
        afterUsd: number;
        perMInput: number;
        perMOutput: number;
        basis: string;
    } | null;
}

/** 美元（小额 4 位、再小给 5 位；0 写成 0） */
function usd(v: number): string {
    if (!Number.isFinite(v)) return "–";
    if (v === 0) return "$0";
    return v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(5)}`;
}

const ROW_H = 32;

export function CompactCutBar(props: {
    uri: () => string;
    onApplied?: () => void;
    /** `panel`（缺省）= 抽屉里的完整版（滑杆 + 轮次表 + 价格）；`card` = 悬停小卡（只有滑杆 + 读数） */
    variant?: "panel" | "card";
}) {
    const card = (): boolean => props.variant === "card";
    const [view, { refetch }] = createResource(props.uri, async (u) =>
        u === "" ? undefined : ((await localChatStore.compactLedger(u)) as RoundsView),
    );
    /** 滑块位置 = 保留最近几轮；`null` = 跟随当前生效值 */
    const [keep, setKeep] = createSignal<number | null>(null);
    const [busy, setBusy] = createSignal(false);
    const [note, setNote] = createSignal<string | null>(null);

    const total = (): number => view()?.total ?? 0;
    const appliedKept = (): number => view()?.keptCount ?? 0;
    const keptCount = (): number => Math.min(total(), Math.max(0, Math.round(keep() ?? appliedKept())));
    const lo = (): number => total() - keptCount();                    // 保留起点（第几轮开始留）
    const dirty = (): boolean => keptCount() !== appliedKept();

    const keptTokens = createMemo(() => {
        const v = view();
        if (!v) return 0;
        return v.rounds.slice(lo()).reduce((n, r) => n + r.tokens, 0);
    });
    const droppedTokens = createMemo(() => {
        const v = view();
        if (!v) return 0;
        return v.rounds.slice(0, lo()).reduce((n, r) => n + r.tokens, 0);
    });

    async function apply(): Promise<void> {
        setBusy(true);
        setNote(null);
        try {
            const r = (await localChatStore.compactSetKept(props.uri(), keptCount())) as {
                applied: { dropped: number; keptMessages: number } | null;
            };
            if (r?.applied === null) setNote("没有可压的（历史本来就不多 / 已到最早一轮）");
            else if (r?.applied) setNote(`已压：丢 ${r.applied.dropped} 条，留 ${r.applied.keptMessages} 条`);
            await refetch();
            props.onApplied?.();
        } catch (e) {
            setNote(`失败：${(e as Error).message}`);
        } finally {
            setBusy(false);
        }
    }

    /** 拖动后把压缩点滚到可视区中间（装得下就滚 0） */
    let listEl: HTMLDivElement | undefined;
    function centerCut(): void {
        const el = listEl;
        if (!el) return;
        const cut = el.querySelector<HTMLElement>("[data-cut]");
        if (!cut) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) {
            el.scrollTop = 0;
            return;
        }
        el.scrollTop = Math.max(0, Math.min(max, cut.offsetTop - el.clientHeight / 2));
    }

    return (
        <section
            class={card() ? "min-w-0" : "min-w-0 space-y-1"}
            data-compact-cut-bar={card() ? "card" : "panel"}
        >
            {/* 滑杆 */}
            <div class="flex items-center gap-2">
                <span class={card() ? "text-caption opacity-70" : "text-body font-bold tracking-wide opacity-80"}>
                    压缩点
                </span>
                <span class="ml-auto text-caption tabular-nums opacity-80" data-cut-readout>
                    <Show when={view()} fallback={<span class="opacity-50">读取中…</span>}>
                        保留最近 <b class="text-success">{keptCount()}</b> 轮 / 共 {total()} 轮
                    </Show>
                </span>
            </div>

            <Show when={view()} fallback={null}>
                <input
                    type="range"
                    class="range range-primary range-xs w-full"
                    min="0"
                    max={String(Math.max(1, total()))}
                    step="1"
                    value={String(keptCount())}
                    disabled={total() === 0}
                    aria-label="保留最近几轮"
                    data-cut-slider
                    onInput={(e) => {
                        setKeep(Number((e.currentTarget as HTMLInputElement).value));
                        centerCut();
                    }}
                />
                <div class="flex justify-between text-caption opacity-45">
                    <span>保留 0 轮</span>
                    <span>保留全部（不压缩）</span>
                </div>

                {/* 轮次表（card 版不显示：那张卡只有 288px 宽） */}
                <Show when={!card()}>
                    <div
                        ref={listEl}
                        class="max-h-72 overflow-y-auto rounded border border-base-300 pt-6"
                        data-cut-list
                    >
                        <For each={view()!.rounds}>
                            {(r, i) => (
                                <>
                                    <Show when={i() === lo() && lo() > 0 && lo() < total()}>
                                        <CutLine dropped={lo()} kept={keptCount()} />
                                    </Show>
                                    <div
                                        class={`grid h-8 grid-cols-[3.5rem_1fr_3.5rem] items-center gap-2 px-2.5 text-caption ${
                                            r.kept ? "bg-success/5" : "bg-error/5"
                                        }`}
                                        data-cut-row={r.label}
                                        title={`${r.label}${r.title ? `：${r.title}` : ""}（${fmtTokens(r.tokens)}）`}
                                    >
                                        <span class={`font-mono text-[11px] ${r.kept ? "opacity-70" : "text-error/70 line-through"}`}>
                                            {r.label}
                                        </span>
                                        <span
                                            class={`truncate ${r.kept ? "" : "text-error/70 line-through decoration-error/40"}`}
                                        >
                                            {r.title || "（无正文摘要）"}
                                        </span>
                                        <span class="text-right font-mono text-[11px] opacity-60">{fmtTokens(r.tokens)}</span>
                                    </div>
                                </>
                            )}
                        </For>
                        <Show when={lo() === 0}>
                            <CutLine dropped={0} kept={keptCount()} allKept />
                        </Show>
                        <Show when={lo() >= total() && total() > 0}>
                            <div class="px-2.5 py-1">
                                <CutLine dropped={lo()} kept={0} />
                            </div>
                        </Show>
                    </div>

                    <Show when={view()!.truncated}>
                        <div class="text-caption opacity-50">只加载了最近 {total()} 轮（更早的仍在盘上）</div>
                    </Show>
                </Show>

                {/* 价格：上一轮 vs 压后（都是**估算**，未计缓存折扣） */}
                <Show when={view()!.price}>
                    {(p) => (
                        <div class="flex flex-wrap items-baseline gap-x-2 text-caption" data-cut-price>
                            <span class="opacity-60">下一轮预计</span>
                            <span class="font-mono text-success" data-cut-price-after>
                                {usd(p().afterUsd)}
                            </span>
                            <span class="opacity-60">（现在 {usd(p().nowUsd)}）</span>
                            <span class="ml-auto opacity-45" title={`按 ${p().basis} 的价目：输入 $${p().perMInput}/M、输出 $${p().perMOutput}/M`}>
                                未计缓存折扣 · {p().basis}
                            </span>
                        </div>
                    )}
                </Show>

                <div class="flex items-center gap-2">
                    <span class="text-caption opacity-70" data-cut-summary>
                        丢 {lo()} 轮（{fmtTokens(droppedTokens())}）· 留 {keptCount()} 轮（{fmtTokens(keptTokens())}）
                    </span>                    <button
                        type="button"
                        class="btn btn-primary btn-xs ml-auto"
                        disabled={busy() || !dirty() || total() === 0}
                        onClick={() => void apply()}
                        data-cut-apply
                    >
                        {busy() ? "压缩中…" : dirty() ? "压缩" : "已生效"}
                    </button>
                
                </div>

                <Show when={keptCount() === 0}>
                    <div class="text-caption text-warning">
                        ⚠ 0 轮 = 历史全清（那等于换一个新会话，不是压缩），所以这个位置不能落盘 —— 往右挪一轮再压。
                    </div>
                </Show>
                <Show when={note()}>
                    <div class="text-caption opacity-70" data-cut-note>
                        {note()}
                    </div>
                </Show>
            </Show>
        </section>
    );
}

/** 压缩点：红色虚线 + 剪刀（线上 = 会丢，线下 = 保留） */
function CutLine(props: { dropped: number; kept: number; allKept?: boolean }) {
    return (
        <div class="relative h-0 border-t-2 border-dashed border-error" data-cut>
            <span class="absolute -top-2 left-1 rounded bg-base-100 px-0.5 text-caption text-error">✂️</span>
            <span class="absolute -top-2 left-6 rounded bg-base-100 px-1 text-[10.5px] font-mono text-error">压缩点</span>
            <span class="absolute -top-2.5 right-1.5 rounded bg-error px-1.5 text-[10.5px] font-mono font-bold text-error-content">
                {props.allKept ? "不压缩（全留）" : props.kept === 0 ? "全清（一轮不留）" : `丢 ${props.dropped} 轮 / 留 ${props.kept} 轮`}
            </span>
        </div>
    );
}

/**
 * WatchCapsule — 顶栏的 **JobWatch 统一入口**（##408 v2 刀 4，B1 形态）。
 *
 * 用户 2026-10-26 的口径：
 *   「B 顶栏胶囊作为统一入口，具有当前任务感知能力，面板列出所有观察者……
 *     只显示一层被观测对象，然后当前任务自己观察的那一条高亮选中」
 *
 * 所以这里只有**一层**：一行 = 一条 watch（= 一个被观察对象）。
 * 不再按「谁收 / 谁看」做树 —— 现在 `subject` 是单值，两层树等于每层只有一个孩子。
 *
 * 三条判据：
 *   ① **胶囊数字 = 全局**（不是「当前任务的」）：切到任何页面都该看见「有 1 条坏了」。
 *   ② **当前任务的排最前并高亮**：一打开就先看见「我在盯什么」。
 *   ③ **没有 watch 时不轮询**（`watchStore.watch` 有订阅计数），空转是 ##401 要治的毛病。
 *
 * 不做的事（留给后续）：新建（仍走 CLI `diy job watch save`）、编辑、批量清理。
 */

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { watchStore } from "../store/watchStore";
import type { WatchRow } from "../store/watchStore";

/** 灯与文案的唯一映射（与 `api-impl.ts::stateLabelOf` 的取值一一对应，不另造状态）。 */
const STATE_META: Record<string, { dot: string; text: string }> = {
    watching: { dot: "bg-success", text: "观察中" },
    quiet: { dot: "bg-info", text: "已降频" },
    broken: { dot: "bg-error", text: "坏了" },
    new: { dot: "bg-warning", text: "待建基线" },
    ended: { dot: "bg-base-content/30", text: "已结束" },
    paused: { dot: "bg-base-content/30", text: "已暂停" },
};

function meta(state: string): { dot: string; text: string } {
    return STATE_META[state] ?? { dot: "bg-base-content/30", text: state };
}

function fmtTime(ms: number | null): string {
    if (ms === null) return "—";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function agoText(ms: number | null, now: number): string {
    if (ms === null) return "还没有变化";
    const dt = Math.max(0, now - ms);
    const min = Math.floor(dt / 60_000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
}

export function WatchCapsule(props: { taskUri: string }) {
    const [open, setOpen] = createSignal(false);
    const [now, setNow] = createSignal(Date.now());
    const [peeking, setPeeking] = createSignal<string | null>(null);
    const [peekResult, setPeekResult] = createSignal<{ id: string; text: string } | null>(null);

    onMount(() => {
        const stop = watchStore.watch();
        const clock = setInterval(() => setNow(Date.now()), 30_000);
        // 点外面关闭：浮层是常驻入口，不能一开就挡着对话（Esc 也认）
        const onDoc = (e: MouseEvent) => {
            if (!open()) return;
            const host = document.querySelector("[data-watch-capsule]");
            if (host && e.target instanceof Node && host.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        onCleanup(() => {
            stop();
            clearInterval(clock);
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        });
    });

    /** 当前任务在盯的（浮层里置顶 + 高亮） */
    const mine = () => watchStore.forTask(props.taskUri);
    /** 别人的：按状态权重（broken 最先） + 上次变化倒序 */
    const others = () => {
        const mineIds = new Set(mine().map((w) => w.id));
        const rank: Record<string, number> = { broken: 0, watching: 1, quiet: 2, new: 3, paused: 4, ended: 5 };
        return watchStore
            .snapshot
            .watches.filter((w) => !mineIds.has(w.id))
            .slice()
            .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || (b.lastChangeAt ?? 0) - (a.lastChangeAt ?? 0));
    };

    const activeCount = () => watchStore.active().length;
    const broken = () => watchStore.brokenCount();

    async function doPeek(w: WatchRow) {
        setPeeking(w.id);
        const r = await watchStore.peek(w.id);
        setPeeking(null);
        setPeekResult({ id: w.id, text: r === null ? "探针失败（看 lastError）" : r.diff || "（没有差异）" });
    }

    return (
        <div class="relative shrink-0" data-watch-capsule>
            <button
                class="btn btn-xs gap-1.5"
                classList={{ "btn-error": broken() > 0 }}
                data-testid="watch-capsule"
                data-watch-active={String(activeCount())}
                data-watch-broken={String(broken())}
                aria-label="观察（JobWatch 统一入口）"
                data-tip={broken() > 0 ? `有 ${broken()} 条 watch 坏了` : "隔很久看一眼，变了才说话"}
                onClick={() => setOpen(!open())}
            >
                <span
                    class={`h-2 w-2 shrink-0 rounded-full ${broken() > 0 ? "bg-white/90" : activeCount() > 0 ? "bg-success" : "bg-base-content/30"}`}
                />
                <span class="text-body leading-none">观察</span>
                <Show when={activeCount() > 0}>
                    <span class="text-caption opacity-70">{activeCount()}</span>
                </Show>
            </button>

            <Show when={open()}>
                <div
                    class="absolute right-0 top-full z-30 mt-1 max-h-[70vh] w-[26rem] overflow-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-2xl"
                    data-watch-popover
                >
                    <div class="flex items-center gap-2 px-1 pb-1.5 text-caption opacity-60">
                        <span>被观察对象</span>
                        <span class="badge badge-ghost badge-xs">{watchStore.snapshot.total}</span>
                        <Show when={watchStore.snapshot.total > activeCount()}>
                            <span>· 其中 {watchStore.snapshot.total - activeCount()} 条已停 / 已结束</span>
                        </Show>
                    </div>

                    <Show when={watchStore.error}>
                        {(e) => <div class="px-2 py-1 text-caption text-error">{e()}</div>}
                    </Show>

                    <Show
                        when={watchStore.snapshot.total > 0}
                        fallback={
                            <div class="px-2 py-6 text-center text-caption opacity-50">
                                还没有 watch
                                <div class="mt-1 font-mono text-[11px] opacity-70">
                                    diy job watch save &lt;id&gt; -t "…" --every 30 --probe 'glob:…' --sink task:{props.taskUri}
                                </div>
                            </div>
                        }
                    >
                        {/* 当前任务在盯的：置顶 + 高亮（「我观察的过滤形态」） */}
                        <Show when={mine().length > 0}>
                            <div class="px-1 pb-1 text-caption opacity-50">本任务在盯 · {mine().length}</div>
                            <For each={mine()}>{(w) => <Row w={w} now={now()} mine peeking={peeking()} onPeek={doPeek} />}</For>
                        </Show>

                        <Show when={others().length > 0}>
                            <div class="px-1 pb-1 pt-2 text-caption opacity-50">其他</div>
                            <For each={others()}>{(w) => <Row w={w} now={now()} mine={false} peeking={peeking()} onPeek={doPeek} />}</For>
                        </Show>
                    </Show>

                    <Show when={peekResult()}>
                        {(p) => (
                            <div class="mt-1 rounded-box border border-base-300 bg-base-200/60 p-2">
                                <div class="mb-1 flex items-center gap-2 text-caption opacity-60">
                                    <span class="font-mono">{p().id}</span>
                                    <span>· 看一眼（不动指纹）</span>
                                    <button class="btn btn-ghost btn-xs ml-auto" onClick={() => setPeekResult(null)}>
                                        关闭
                                    </button>
                                </div>
                                <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] opacity-80">
                                    {p().text}
                                </pre>
                            </div>
                        )}
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function Row(props: {
    w: WatchRow;
    now: number;
    mine: boolean;
    peeking: string | null;
    onPeek: (w: WatchRow) => void;
}) {
    const m = () => meta(props.w.state);
    const pace = () => (props.w.state === "quiet" ? `${props.w.every}m→${props.w.intervalMin}m` : `${props.w.every}m`);
    return (
        <div
            class="mb-1 rounded-field border px-2 py-1.5"
            classList={{
                "border-primary/40 bg-primary/5": props.mine,
                "border-base-300": !props.mine,
            }}
            data-watch-row={props.w.id}
        >
            <div class="flex items-center gap-1.5">
                <span class={`h-2 w-2 shrink-0 rounded-full ${m().dot}`} />
                <span class="flex-1 truncate text-body">{props.w.title}</span>
                <Show when={props.mine}>
                    <span class="badge badge-primary badge-xs shrink-0">本任务</span>
                </Show>
                <span class="shrink-0 text-caption opacity-50">{m().text}</span>
            </div>
            <div class="mt-0.5 flex items-center gap-1.5 text-caption opacity-55">
                <span class={props.w.state === "quiet" ? "text-warning" : ""}>{pace()}</span>
                <span>·</span>
                <span class="truncate font-mono text-[11px]">{props.w.subject}</span>
                <span class="ml-auto shrink-0" title={`上次变化 ${fmtTime(props.w.lastChangeAt)}`}>
                    {agoText(props.w.lastChangeAt, props.now)}
                </span>
                <button
                    class="btn btn-ghost btn-xs shrink-0 px-1"
                    classList={{ loading: props.peeking === props.w.id }}
                    data-tip="立刻探一次（不动指纹）"
                    onClick={() => props.onPeek(props.w)}
                >
                    看
                </button>
            </div>
            <Show when={props.w.state === "broken" && props.w.lastError}>
                {(e) => <div class="mt-0.5 truncate font-mono text-[11px] text-error/80">{e()}</div>}
            </Show>
            <Show when={props.w.ended}>
                {(end) => <div class="mt-0.5 text-caption opacity-40">已结束 · {end().reason}</div>}
            </Show>
        </div>
    );
}

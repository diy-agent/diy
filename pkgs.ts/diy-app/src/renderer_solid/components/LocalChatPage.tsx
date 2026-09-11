/**
 * LocalChatPage — 本地自定义 agent 对话页（ai-sdk 块协议，独立于 ACP ChatPage）
 *
 * 渲染 = f(层级 density, 阶段 phase)：
 *   层级 L1 脉络 / L2 阅读 / L3 审计 / L4 取证（工具条切换，localStorage 持久）
 *   阶段 streaming（未 stop）/ settled（定稿）——直播态无视层级做减法，保证进度可见
 *
 * 规则矩阵：
 *   L1: user 全文 + assistant 单行（直播末行/定稿首行）+ ·N 步；过程隐藏
 *   L2: text 全文 + 过程压成发丝线（失败自动展开）；直播另加单行 TurnLiveLine
 *   L3: text 全文 + 过程标题行（点开展示截断输出 + 全屏按钮）
 *   L4: = L3 全部展开（无新组件）
 * 定稿自动收敛：open = pinned ?? (L4 ? true : error? true : false)，直播块天然展开预览。
 */

import { createSignal, For, Show, createEffect, on, onMount, onCleanup } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { Caches, DENSITY_LEVEL, DENSITY_VALUES, type Density } from "../lib/ui-state";
import type { BlockNode } from "../../main/services/local-blocks";

// ─── 层级 ───────────────────────────────────────────

const DENSITY_LABEL: Record<Density, string> = {
    [DENSITY_LEVEL.OUTLINE]: "脉络",
    [DENSITY_LEVEL.READ]: "阅读",
    [DENSITY_LEVEL.AUDIT]: "审计",
    [DENSITY_LEVEL.FORENSIC]: "取证",
};
const DENSITY_TITLE: Record<Density, string> = {
    [DENSITY_LEVEL.OUTLINE]: "脉络：找自己说过啥",
    [DENSITY_LEVEL.READ]: "阅读：读答案",
    [DENSITY_LEVEL.AUDIT]: "审计：查过程",
    [DENSITY_LEVEL.FORENSIC]: "取证：全展开",
};
/** 审计及以上（L3/L4：过程以标题行展示） */
const isAuditPlus = (d: Density) => d === DENSITY_LEVEL.AUDIT || d === DENSITY_LEVEL.FORENSIC;

function loadDensity(): Density {
    return Caches.diy_chat_density.get();
}

// ─── 小工具 ─────────────────────────────────────────

const firstLine = (s: string) => {
    const i = s.indexOf("\n");
    return i === -1 ? s.slice(0, 90) : s.slice(0, i);
};
const tailLine = (s: string) => {
    const t = s.trimEnd();
    const i = t.lastIndexOf("\n");
    return i === -1 ? t : t.slice(i + 1);
};
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** 输出截断：head + tail，中间计省略行数（行内展开用；超预算才挂全屏按钮） */
export interface Preview {
    text: string;
    omitted: number;
    total: number;
}
export function previewLines(text: string, head = 20, tail = 30): Preview {
    const lines = text.split("\n");
    if (lines.length <= head + tail) return { text, omitted: 0, total: lines.length };
    const omitted = lines.length - head - tail;
    return {
        text: [...lines.slice(0, head), `… 省略 ${omitted} 行 …`, ...lines.slice(-tail)].join("\n"),
        omitted,
        total: lines.length,
    };
}

/** assistant 正文（纯文本呈现） */
function PlainText(props: { text: string; class?: string }) {
    return (
        <div class={`whitespace-pre-wrap break-words text-sm leading-relaxed ${props.class ?? ""}`}>
            {props.text}
        </div>
    );
}

// ─── 树工具（文档序） ───────────────────────────────

function descendants(n: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    const walk = (x: BlockNode) => {
        for (const c of x.children) {
            out.push(c);
            walk(c);
        }
    };
    walk(n);
    return out;
}
const processOf = (turn: BlockNode) =>
    descendants(turn).filter((b) => b.tag === "think" || b.tag === "tool");
/** 文档序拉平：叶子块（step 是纯容器，DFS 顺序 = 时间顺序）。
 *  渲染只按此序 + 密度决定可见性，绝不按 kind 重排（时序是协议的基本承诺）。 */
function leavesOf(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    const walk = (n: BlockNode) => {
        for (const c of n.children) {
            if (c.tag === "step") walk(c);
            else out.push(c);
        }
    };
    walk(turn);
    return out;
}
/** L2 专用：连续已定稿的 think/tool 段合并成一条发丝线；失败/直播块打断分组 */
type Seg = { kind: "block"; node: BlockNode } | { kind: "hair"; nodes: BlockNode[] };
function segments(density: Density, leaves: BlockNode[]): Seg[] {
    const isHairable = (b: BlockNode) =>
        (b.tag === "think" || b.tag === "tool") &&
        b.stopped &&
        !(b.tag === "tool" && str(b.attrs.status) === "error");
    if (density !== DENSITY_LEVEL.READ) return leaves.map((node) => ({ kind: "block", node }));
    const out: Seg[] = [];
    let run: BlockNode[] = [];
    const flush = () => {
        if (run.length) out.push({ kind: "hair", nodes: run });
        run = [];
    };
    for (const b of leaves) {
        if (isHairable(b)) run.push(b);
        else {
            flush();
            out.push({ kind: "block", node: b });
        }
    }
    flush();
    return out;
}

/** 展开判定：error 恒开 → 手动 pin → L4 全开；其余默认折叠 */
function isOpen(n: BlockNode, density: Density, pin: Record<string, boolean>): boolean {
    if (n.tag === "error") return true;
    if (n.tag === "tool" && str(n.attrs.status) === "error") return true;
    if (n.id in pin) return pin[n.id]!;
    return density === DENSITY_LEVEL.FORENSIC;
}

// ─── 行摘要与正文 ───────────────────────────────────

function toolCommand(n: BlockNode): string {
    const args = n.attrs.args as { command?: string; path?: string } | undefined;
    if (args?.command) return args.command;
    if (args?.path) return `read ${args.path}`;
    return str(n.attrs.title);
}

function summaryOf(n: BlockNode): string {
    if (n.tag === "think") {
        const t = str(n.attrs.content);
        if (!t) return "思考中…";
        return !n.stopped ? tailLine(t) : firstLine(t);
    }
    if (n.tag === "tool") {
        return `${str(n.attrs.tool) || "tool"}${toolCommand(n) ? ` · ${firstLine(toolCommand(n))}` : ""}`;
    }
    return n.tag;
}

function statusMark(n: BlockNode) {
    if (n.tag === "think") {
        return !n.stopped ? (
            <span class="text-warning animate-pulse">●</span>
        ) : (
            <span>💭</span>
        );
    }
    const s = str(n.attrs.status);
    if (s === "done") return <span class="text-success">✓</span>;
    if (s === "error") return <span class="text-error">✗</span>;
    if (!n.stopped) return <span class="text-warning animate-pulse">●</span>;
    return <span class="opacity-50">○</span>;
}

function ThinkBody(props: { node: BlockNode }) {
    return <div class="whitespace-pre-wrap leading-relaxed">{str(props.node.attrs.content)}</div>;
}

function ToolBody(props: {
    node: BlockNode;
    onFull: (title: string, content: string) => void;
}) {
    const n = props.node;
    const output = () => str(n.attrs.output);
    const pv = () => previewLines(output());
    const title = () => `${str(n.attrs.tool)} · ${toolCommand(n)}`;
    return (
        <div class="space-y-1 font-mono">
            <Show when={toolCommand(n)}>
                <pre class="text-base-content/70">$ {toolCommand(n)}</pre>
            </Show>
            <Show when={output()}>
                <pre class="whitespace-pre-wrap max-h-72 overflow-auto bg-base-100/60 rounded p-2">
                    {pv().text}
                </pre>
            </Show>
            <Show when={pv().omitted > 0}>
                <button
                    class="btn btn-ghost btn-xs opacity-70"
                    onClick={() => props.onFull(title(), output())}
                >
                    全屏查看（共 {pv().total} 行）
                </button>
            </Show>
        </div>
    );
}

/** 过程行：标题 + 状态灯 + Chevron；正文按 open 渲染；直播且展开时跟随到底 */
function ProcessRow(props: {
    node: BlockNode;
    density: Density;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const n = () => props.node;
    const open = () => isOpen(n(), props.density, props.pin);
    let bodyRef: HTMLDivElement | undefined;
    // 直播展开时跟随到底：订阅整树信号（每 op 重跑一次），仅当 open 且未定稿
    createEffect(() => {
        void localChatStore.trees;
        if (open() && !n().stopped && bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
    });
    return (
        <div class="rounded-lg border border-base-300 bg-base-200/40 text-xs">
            <button
                class="flex items-center gap-2 cursor-pointer select-none px-2.5 py-1.5 w-full text-left"
                onClick={() => props.onToggle(n().id)}
            >
                {statusMark(n())}
                <span class="font-medium text-base-content/80 truncate flex-1">{summaryOf(n())}</span>
                <span class="opacity-40 text-[11px]">{open() ? "▴" : "›"}</span>
            </button>
            <Show when={open()}>
                <div ref={(el) => (bodyRef = el)} class="px-3 pb-2 max-h-72 overflow-auto">
                    <Show when={n().tag === "think"}>
                        <ThinkBody node={n()} />
                    </Show>
                    <Show when={n().tag === "tool"}>
                        <ToolBody node={n()} onFull={props.onFull} />
                    </Show>
                </div>
            </Show>
        </div>
    );
}

// ─── Turn 视图：文档序渲染 + 密度可见性矩阵 ──────────
//
// 铁律：块按时间（DFS 文档序）呈现，密度只决定「怎么显示/是否显示」，
// 绝不按 kind 重排分组——tool 执行完才产生的 text 结论，必须画在 tool 之后。

/** 连续已定稿过程段的发丝线（L2） */
function HairSeg(props: { nodes: BlockNode[] }) {
    const tools = () => props.nodes.filter((b) => b.tag === "tool").length;
    const thinks = () => props.nodes.filter((b) => b.tag === "think").length;
    return (
        <div class="flex items-center gap-2 text-[11px] opacity-40 select-none py-0.5">
            <span class="flex-1 border-t border-base-300" />
            <span>
                <Show when={tools()}>⚙ {tools()} </Show>
                <Show when={thinks()}>· 💭 {thinks()}</Show>
            </span>
            <span class="flex-1 border-t border-base-300" />
        </div>
    );
}

function LeafView(props: {
    node: BlockNode;
    density: Density;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const b = props.node;
    // user 发言：一切密度下都全文——它就是"我说过啥"的脉络本体
    if (b.tag === "text" && str(b.attrs.role) === "user") {
        return (
            <div class="max-w-[85%] self-end bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                {str(b.attrs.content)}
            </div>
        );
    }
    if (b.tag === "text") {
        // assistant 正文：L1 单行（直播取末行/定稿取首行），L2+ 全文（流式照常平铺）
        if (props.density === DENSITY_LEVEL.OUTLINE) {
            const t = str(b.attrs.content);
            return (
                <div class="text-sm opacity-80 truncate">
                    {b.stopped ? firstLine(t) : tailLine(t)}
                    <Show when={!b.stopped}>
                        <span class="animate-pulse">▋</span>
                    </Show>
                </div>
            );
        }
        return <PlainText text={str(b.attrs.content)} />;
    }
    if (b.tag === "think" || b.tag === "tool") {
        const failed = b.tag === "tool" && str(b.attrs.status) === "error";
        // 直播中的过程块：所有密度都显示为进度行（静默的是内容，不是活动）
        if (!b.stopped || failed || isAuditPlus(props.density)) {
            return (
                <ProcessRow
                    node={b}
                    density={props.density}
                    pin={props.pin}
                    onToggle={props.onToggle}
                    onFull={props.onFull}
                />
            );
        }
        return null; // L1/L2 定稿过程：L1 隐藏；L2 由 HairSeg 聚合（segments 合并过，单块即一段）
    }
    if (b.tag === "error") {
        return (
            <div class="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error whitespace-pre-wrap">
                {`❌ [${str(b.attrs.source)}] ${str(b.attrs.message)}`}
            </div>
        );
    }
    if (b.tag === "plan") {
        if (props.density === DENSITY_LEVEL.OUTLINE) return null;
        return (
            <div class="text-xs opacity-70">
                📋 计划：
                <For each={(b.attrs.items as unknown[]) ?? []}>{(it) => <div>• {str(it)}</div>}</For>
            </div>
        );
    }
    return <div class="text-xs opacity-40">[未知块 {b.tag}]</div>;
}

function TurnView(props: {
    node: BlockNode;
    density: Density;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
    liveTurnId: string | null;
}) {
    const t = props.node;
    const segs = () => segments(props.density, leavesOf(t));
    const procCount = () => processOf(t).length;
    const isLiveTurn = () => props.liveTurnId != null && props.liveTurnId === t.id;
    return (
        <div class="space-y-1.5">
            {/* 唯一渲染循环：文档序分段，密度只作用于每段的呈现方式 */}
            <For each={segs()}>
                {(seg) =>
                    seg.kind === "hair" ? (
                        <HairSeg nodes={seg.nodes} />
                    ) : (
                        <LeafView
                            node={seg.node}
                            density={props.density}
                            pin={props.pin}
                            onToggle={props.onToggle}
                            onFull={props.onFull}
                        />
                    )
                }
            </For>
            {/* L1 页脚：被隐藏的过程给个计数，不展开内容 */}
            <Show when={props.density === DENSITY_LEVEL.OUTLINE && procCount() > 0}>
                <div class="text-[11px] opacity-40">· {procCount()} 步</div>
            </Show>
            {/* 截断/步数耗尽提示：main 按生效 limits 写入，限制值动态非硬编码 */}
            <Show when={str(t.attrs.notice)}>
                <div class="text-[11px] text-warning">⚠ {str(t.attrs.notice)}</div>
            </Show>
            <Show when={t.attrs.usage}>
                {(() => {
                    const u = t.attrs.usage as { in?: number; out?: number; total?: number };
                    return (
                        <div class="text-[11px] opacity-50">
                            tokens ↑{u.in ?? 0} ↓{u.out ?? 0}（Σ{u.total ?? 0}）
                        </div>
                    );
                })()}
            </Show>
            <Show when={t.attrs.interrupted && !isLiveTurn()}>
                <div class="text-[11px] text-warning">⚠ 本轮未完成（流中断/崩溃恢复）</div>
            </Show>
            <Show when={isLiveTurn()}>
                <div class="text-[11px] opacity-50 animate-pulse">生成中…</div>
            </Show>
        </div>
    );
}

// ─── 全屏输出 ───────────────────────────────────────

function FullscreenModal(props: { title: string; content: string; onClose: () => void }) {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") props.onClose();
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(props.content);
            notificationStore.addToast("success", "已复制到剪贴板");
        } catch (e) {
            // 用户主动触发的动作：失败必须告知，不能假装成功
            console.error("[localChat] 剪贴板写入失败：", e);
            notificationStore.addToast("error", "复制失败（剪贴板不可用）");
        }
    };
    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div class="bg-base-100 rounded-xl w-full max-w-4xl max-h-full flex flex-col">
                <div class="flex items-center gap-2 px-4 py-2 border-b shrink-0">
                    <span class="font-mono text-xs truncate flex-1">{props.title}</span>
                    <button class="btn btn-ghost btn-xs" onClick={copy}>
                        复制
                    </button>
                    <button class="btn btn-ghost btn-xs" onClick={() => props.onClose()}>
                        ✕
                    </button>
                </div>
                <pre class="overflow-auto p-4 text-xs font-mono whitespace-pre-wrap break-all flex-1">
                    {props.content}
                </pre>
            </div>
        </div>
    );
}

// ─── 页面 ───────────────────────────────────────────

export function LocalChatPage() {
    const uri = () => taskStore.selectedUri ?? null;
    let inputRef: HTMLTextAreaElement | undefined;
    let scrollRef: HTMLDivElement | undefined;
    /** 恢复某会话的阅读位置：open（含历史重放）完成后，等渲染帧再设 scrollTop */
    const restore = (u: string) => {
        void localChatStore.open(u).then(() => {
            const p = localChatStore.getScroll(u);
            if (p > 0) {
                requestAnimationFrame(() => {
                    if (scrollRef) scrollRef.scrollTop = p;
                });
            }
        });
    };
    // 首挂（切页面/组件重建，TaskState 在内存保留）：恢复当前任务阅读位置
    onMount(() => {
        const u = uri();
        if (u) restore(u);
    });
    // 直播中的尾轮 turn id（running 时才有）：中断警告 gating 用
    const liveTurnId = () => {
        if (!localChatStore.running) return null;
        const turns = localChatStore.trees.filter((t) => t.tag === "turn");
        return turns.length ? turns[turns.length - 1]!.id : null;
    };
    // 密度（持久化）与手动 pin（局部覆盖，不跳变）
    const [density, setDensityRaw] = createSignal<Density>(loadDensity());
    const setDensity = (d: Density) => {
        setDensityRaw(d);
        Caches.diy_chat_density.set(d);
    };
    const [pinned, setPinned] = createSignal<Record<string, boolean>>({});
    const togglePin = (id: string) => setPinned((p) => ({ ...p, [id]: !p[id] }));
    const [full, setFull] = createSignal<{ title: string; content: string } | null>(null);

    createEffect(
        on(uri, (u, prev) => {
            // 切走前保存旧会话阅读位置（组件不卸载，滚动容器 DOM 还在）
            if (prev && scrollRef) localChatStore.setScroll(prev, scrollRef.scrollTop);
            // 进入新会话：内容恢复（历史重放）+ 阅读位置恢复
            if (u) restore(u);
        }),
    );

    const submit = async () => {
        const el = inputRef;
        if (!el) return;
        const text = el.value.trim();
        if (!text || !uri() || localChatStore.running) return;
        el.value = "";
        await localChatStore.send(uri()!, text);
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            {/* 顶部：密度切换 + 模型选择 + 会话操作 */}
            <div class="flex items-center gap-2 px-4 py-2 border-b shrink-0 text-xs">
                <div class="join">
                    <For each={[...DENSITY_VALUES]}>
                        {(d) => (
                            <button
                                class={`btn btn-xs join-item ${density() === d ? "btn-active" : ""}`}
                                title={DENSITY_TITLE[d]}
                                onClick={() => setDensity(d)}
                            >
                                {DENSITY_LABEL[d]}
                            </button>
                        )}
                    </For>
                </div>
                <span class="opacity-60">模型</span>
                <select
                    class="select select-xs select-bordered max-w-[220px]"
                    value={localChatStore.activeModel}
                    disabled={localChatStore.running}
                    onChange={(e) => localChatStore.setActiveModel(e.currentTarget.value)}
                >
                    <For each={localChatStore.models}>
                        {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                </select>
                <span class="badge badge-outline badge-xs">ai-sdk local</span>
                <div class="flex-1" />
                <Show when={!localChatStore.running}>
                    <button
                        class="btn btn-ghost btn-xs"
                        onClick={() => uri() && void localChatStore.clear(uri()!)}
                    >
                        清空
                    </button>
                </Show>
            </div>

            {/* 块树滚动区 */}
            <div ref={(el) => (scrollRef = el)} class="flex-1 overflow-y-auto px-4 py-3">
                <div class="space-y-3">
                    <For each={localChatStore.trees}>
                        {(t) =>
                            t.tag === "turn" ? (
                                <TurnView
                                    node={t}
                                    density={density()}
                                    pin={pinned()}
                                    onToggle={togglePin}
                                    onFull={(title, content) => setFull({ title, content })}
                                    liveTurnId={liveTurnId()}
                                />
                            ) : (
                                <div class="text-xs opacity-40">[未知根 {t.tag}]</div>
                            )
                        }
                    </For>
                    <Show when={localChatStore.error}>
                        <div class="text-error text-xs">{localChatStore.error}</div>
                    </Show>
                    <Show when={localChatStore.running}>
                        <div class="text-xs opacity-50 animate-pulse">生成中…</div>
                    </Show>
                </div>
            </div>

            {/* 输入条 */}
            <div class="border-t p-3 shrink-0">
                <div class="flex gap-2 items-end">
                    <textarea
                        ref={(el) => (inputRef = el)}
                        rows={2}
                        class="textarea textarea-bordered flex-1 resize-none text-sm"
                        placeholder="本地 agent（回车发送 / Shift+回车换行）…"
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void submit();
                            }
                        }}
                    />
                    <Show
                        when={!localChatStore.running}
                        fallback={
                            <button
                                class="btn btn-error btn-sm"
                                onClick={() => uri() && void localChatStore.cancel(uri()!)}
                            >
                                停止
                            </button>
                        }
                    >
                        <button class="btn btn-primary btn-sm" onClick={() => void submit()}>
                            发送
                        </button>
                    </Show>
                </div>
            </div>

            {/* 全屏输出 */}
            <Show when={full()}>
                {(f) => <FullscreenModal title={f().title} content={f().content} onClose={() => setFull(null)} />}
            </Show>
        </div>
    );
}

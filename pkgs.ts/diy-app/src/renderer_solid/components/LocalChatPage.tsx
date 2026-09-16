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
import { draftStore } from "../store/draftStore";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { Caches, DENSITY_LEVEL, DENSITY_VALUES, type Density } from "../lib/ui-state";
import { MarkdownView } from "./MarkdownView";
import { onEnterKey } from "../lib/on-enter";
import type { BlockNode } from "../../main/services/local-blocks";
import { INTERRUPTED_TOOL_NOTICE } from "../../main/services/local-blocks";

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

// ─── 滚动跟随（stick-to-bottom） ──────────────────────────────
//
// 语义：用户停在底部 → agent 出内容由我们主动滚到底（跟随）；
//       用户往上翻阅读 → 立刻停止跟随，绝不打扰（跟随 effect 只看 stick）。
//
// 为什么不用 ResizeObserver：本页面改高度的不止 agent 输出（手动展开过程块、
// 切 MD/原文 会重建 DOM、窗口 resize），布局驱动会把这些误判成"有新内容"，
// 表现为"用户在翻历史，被一把拽到最新"。改用 localChatStore.trees 信号驱动，
// 语义精确 = 真的产出了新块。
// 为什么不开 overflow-anchor：它是"防上方内容变形顶走视口"的保险丝，且会与
// 我们主动赋值 scrollTop 抢位置。当前 Markdown 只在本块内增长、历史块 memo
// 稳定不变高，Shiki 同步无异步撑高 → 用不上，反而添乱。
const STICK_PX = 32;
/** 是否已贴底（容差内即算底部，避免差 1px 永远跟不住） */
const nearBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;

/** assistant 正文（纯文本呈现）：原文模式 + L1 单行摘要用 */
function PlainText(props: { text: string; class?: string }) {
    return (
        <div class={`whitespace-pre-wrap break-words text-sm leading-relaxed ${props.class ?? ""}`}>
            {props.text}
        </div>
    );
}

/** assistant 正文（Markdown 富文本）：与原文模式共用同一数据源，仅渲染方式不同 */
function MarkdownText(props: { text: string; streaming: boolean }) {
    return <MarkdownView content={props.text} streaming={props.streaming} />;
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

/** 本轮是否已出现助理侧内容（think/tool/text-assistant/error/plan）。
 *  发送后到首个助理事件之间有一段真空期（握手 + 上游首 token 往返），
 *  此时界面上只有 user 气泡，需要 loading 图标填充"正在处理"的反馈；
 *  一旦助理内容出现即让位给真实消息（含流式思考过程）。 */
function hasAssistantContent(turn: BlockNode): boolean {
    return leavesOf(turn).some((n) => !(n.tag === "text" && str(n.attrs.role) === "user"));
}
/** 文档序拉平：叶子块（step 是纯容器，DFS 顺序 = 时间顺序）。
 *  渲染只按此序 + 密度决定可见性，绝不按 kind 重排（时序是协议的基本承诺）。
 *  兼底：任何带 children 的容器都向下递归，否则一旦数据里出现嵌套容器
 *  （如旧日志中的嵌套 turn），整段子树会直接不渲染。 */
function leavesOf(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    const walk = (n: BlockNode) => {
        for (const c of n.children) {
            if (c.tag === "step" || c.children.length > 0) walk(c);
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

/**
 * 中断的 tool 块：
 *   ① 显式终态 status=interrupted（main 已收敛并写进 ops）→ 直接读，不靠推断
 *   ② 兼容旧会话：未收 stop 且当前无轮次在跑（历史日志里还没收敛）
 */
function isInterruptedToolBlock(n: BlockNode): boolean {
    if (n.tag !== "tool") return false;
    const s = str(n.attrs.status);
    if (s === "interrupted") return true;
    if (n.stopped) return false;
    if (s === "done" || s === "error") return false;
    return !localChatStore.running;
}

/** 展开判定：error 恒开 → 中断的 tool 恒开（要让人一眼看到"最后一句断在哪"）→ 手动 pin → L4 全开 */
function isOpen(n: BlockNode, density: Density, pin: Record<string, boolean>): boolean {
    if (n.tag === "error") return true;
    if (n.tag === "tool" && str(n.attrs.status) === "error") return true;
    if (isInterruptedToolBlock(n)) return true;
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
        return `${str(n.attrs.tool) || "tool"}${toolCommand(n) ? ` · ${firstLine(toolCommand(n))}` : ""}${isInterruptedToolBlock(n) ? " · ⊘ 中断" : ""}`;
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
    // 中断遗留（无 stop、无结果）：不能跟"正在执行"共用同一个点，否则用户看不出历史断在哪
    if (isInterruptedToolBlock(n)) {
        return (
            <span class="text-warning" title="上一轮中断，没有结果（此行已被收敛为终态，正文与发往模型的同源）">
                ⊘
            </span>
        );
    }
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
            {/* 中断遗留：正文显示与发往 LLM 完全同源的占位说明（不再是空白让人无从下手） */}
            <Show when={isInterruptedToolBlock(n)}>
                <div class="alert alert-warning alert-soft text-xs py-2 font-sans">
                    <span class="whitespace-pre-wrap">{INTERRUPTED_TOOL_NOTICE}</span>
                </div>
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
        <div class="rounded-lg border border-base-300 bg-base-200/40 text-xs" data-block-id={n().id} data-block-tag={n().tag}>
            <button
                type="button"
                class="flex items-center gap-2 cursor-pointer select-none px-2.5 py-1.5 w-full text-left"
                onPointerDown={(e) => e.preventDefault()}
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
    /** 正文字段是否走 Markdown 富文本（全局开关） */
    md: boolean;
}) {
    const b = props.node;
    // user 发言：一切密度下都全文——它就是"我说过啥"的脉络本体
    // 右对齐：外层用 flex justify-end（原先的 self-end 在 block 父链里完全无效）
    if (b.tag === "text" && str(b.attrs.role) === "user") {
        return (
            <div class="flex justify-end">
                <div class="max-w-[85%] bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                    {str(b.attrs.content)}
                </div>
            </div>
        );
    }
    if (b.tag === "text") {
        // assistant 正文：L1 单行（直播取末行/定稿取首行），L2+ 全文（流式照常平铺）
        if (props.density === DENSITY_LEVEL.OUTLINE) {
            const t = str(b.attrs.content);
            // L1 摘要恒为纯文本：截断出的半行 Markdown（断在 ** 、``` 、表格 | 中间）
            // 会被解析成错乱结构，这里绝不能走 Markdown 渲染
            return (
                <div class="text-sm opacity-80 truncate">
                    {b.stopped ? firstLine(t) : tailLine(t)}
                    <Show when={!b.stopped}>
                        <span class="animate-pulse">▋</span>
                    </Show>
                </div>
            );
        }
        const text = str(b.attrs.content);
        if (!props.md) return <PlainText text={text} />;
        return <MarkdownText text={text} streaming={!b.stopped} />;
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
    md: boolean;
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
                            md={props.md}
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
            {/* 等待助理首个事件：仅本轮生成中且尚无助理内容时显示。
                首个事件到达即自动消失（isLiveTurn 或 hasAssistantContent 变化都会重算）。 */}
            <Show when={isLiveTurn() && !hasAssistantContent(t)}>
                <div class="flex items-center gap-2 text-primary py-0.5">
                    <span class="loading loading-bars loading-sm" aria-label="等待响应" />
                </div>
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

// ─── 确认弹窗（破坏性操作前置确认） ─────────────────

function ConfirmDialog(props: {
    title: string;
    message: string;
    confirmLabel: string;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") props.onCancel();
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));
    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onCancel();
            }}
        >
            <div class="bg-base-100 rounded-xl w-full max-w-sm flex flex-col">
                <div class="px-4 py-3 border-b font-bold text-sm">{props.title}</div>
                <div class="px-4 py-3 text-xs opacity-80">{props.message}</div>
                <div class="px-4 py-2 border-t flex justify-end gap-2">
                    {/* 焦点落在「取消」：回车/空格不会误触发不可恢复的删除 */}
                    <button class="btn btn-xs" autofocus onClick={props.onCancel}>
                        取消
                    </button>
                    <button class="btn btn-error btn-xs" onClick={props.onConfirm}>
                        {props.confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── 页面 ───────────────────────────────────────────

export function LocalChatPage() {
    const uri = () => taskStore.selectedUri ?? null;
    let inputRef: HTMLTextAreaElement | undefined;
    let scrollRef: HTMLDivElement | undefined;
    /** 跟随态：true=贴底（新内容自动滚到底）；false=用户正在上方阅读（绝不打扰） */
    const [stick, setStick] = createSignal(true);
    /** 恢复中闸门：历史重放期间 trees 连发，须让位给 restore 的定位（否则被抢先滚到底） */
    let restoring = false;

    /** 滚到底并置跟随态 */
    const gotoBottom = () => {
        const el = scrollRef;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        setStick(true);
    };

    /** 恢复某会话阅读位置：有记录（p>0）回到该处并按位置校准跟随态；
     *  无记录（p=0，含新会话）→ 直接看最新，而不是停在顶部。 */
    const restore = (u: string) => {
        restoring = true;
        void localChatStore.open(u).catch(() => undefined).then(() => {
            const p = localChatStore.getScroll(u);
            requestAnimationFrame(() => {
                restoring = false;
                const el = scrollRef;
                if (!el) return;
                if (p > 0) {
                    el.scrollTop = p;
                    setStick(nearBottom(el)); // 上次停在底部 → 继续跟随；否则尊重阅读位置
                } else {
                    gotoBottom();
                }
            });
        });
    };
    /** 把草稿回填进 textarea（只在换任务 / 服务端草稿到达 / 首挂时调用，不逐键回写） */
    const applyDraft = (u: string | null) => {
        if (!inputRef) return;
        inputRef.value = draftStore.get(u, "agent_input");
    };
    // 首挂（切页面/组件重建，TaskState 在内存保留）：恢复当前任务阅读位置 + 输入框草稿
    onMount(() => {
        const u = uri();
        if (u) {
            restore(u);
            applyDraft(u);
        }
    });
    // 组件卸载（切 tab 到 info）前把防抖中的草稿落盘（内容在 input 事件里已写进 draftStore）
    onCleanup(() => {
        const u = uri();
        if (u) void draftStore.flushNow(u);
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
    // Markdown 渲染开关（视图 cache 持久化，与密度同级）：全局开关而非 per-message
    const [md, setMdRaw] = createSignal<boolean>(Caches.diy_chat_md.get());
    const setMd = (v: boolean) => {
        setMdRaw(v);
        Caches.diy_chat_md.set(v);
    };
    /** 清空确认：清空会删掉 main 侧 ops/llm 日志（rmSync，不可恢复），必须二次确认 */
    const [confirmClear, setConfirmClear] = createSignal(false);
    const [pinned, setPinned] = createSignal<Record<string, boolean>>({});
    const togglePin = (id: string) => setPinned((p) => ({ ...p, [id]: !p[id] }));
    const [full, setFull] = createSignal<{ title: string; content: string } | null>(null);

    createEffect(
        on(uri, (u, prev) => {
            // 切走前保存旧会话阅读位置（组件不卸载，滚动容器 DOM 还在）+ 冲掉待写草稿
            if (prev) {
                if (scrollRef) localChatStore.setScroll(prev, scrollRef.scrollTop);
                void draftStore.flushNow(prev);
            }
            // 进入新会话：内容恢复（历史重放）+ 阅读位置恢复 + 输入框草稿恢复
            if (u) {
                restore(u);
                applyDraft(u);
            }
        }),
    );
    // 草稿从服务端到达（seed）后回填：getTask 是异步的，首挂时草稿可能还没到。
    // 用 seedTick 而非 version —— version 每次输入都变，逐键回写会打断光标与输入法组词。
    createEffect(
        on(
            () => draftStore.seedTick,
            () => applyDraft(uri()),
        ),
    );

    // 跟随：内容变化（trees 信号）→ 贴底则滚到底。
    //
    // 顺序要求：必须声明在上方 uri 切换 effect 之后——Solid 按创建顺序执行 effect，
    //   切会话时 uri effect 先同步置 restoring 闸门，本 effect 才会让位给 restore 的定位。
    // 时机：createEffect 在 DOM 写入之后运行，故 scrollHeight 已含新内容（同步赋值无闪帧）；
    //   再补一帧 rAF 兜住布局后置变化。rAF 内重读 stick——期间用户若已上滚则放弃，不抢位置。
    createEffect(() => {
        void localChatStore.trees;
        if (restoring || !stick()) return;
        const el = scrollRef;
        if (el) el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
            const e2 = scrollRef;
            if (e2 && stick()) e2.scrollTop = e2.scrollHeight;
        });
    });

    const submit = async () => {
        const el = inputRef;
        if (!el) return;
        const text = el.value.trim();
        if (!text || !uri() || localChatStore.running) return;
        el.value = "";
        // 内容已作为消息发出，草稿使命结束：清掉，避免下次进入看到已发送的旧文本
        void draftStore.clear(uri()!, ["agent_input"]);
        setStick(true); // 刚发出，必然想看回复：无视之前是否在上方阅读
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
                {/* 显示方式二选一：两个选项都可见，当前态高亮 —— 单按钮式「MD」看不出
                    处于哪一态（切回去要猜），且与右侧破坏性按钮同形，易误点。 */}
                <div class="join" role="group" aria-label="Markdown 显示方式">
                    <button
                        class={`btn btn-xs join-item ${md() ? "btn-ghost" : "btn-active"}`}
                        title="原文：按纯文本显示，不做 Markdown 渲染"
                        aria-pressed={!md()}
                        onClick={() => setMd(false)}
                    >
                        MD 原文
                    </button>
                    <button
                        class={`btn btn-xs join-item ${md() ? "btn-active" : "btn-ghost"}`}
                        title="渲染：按 Markdown 富文本显示"
                        aria-pressed={md()}
                        onClick={() => setMd(true)}
                    >
                        MD 渲染
                    </button>
                </div>
                <Show when={!localChatStore.running}>
                    <button
                        class="btn btn-ghost btn-xs"
                        title="删除本任务的全部本地对话历史（ops/llm 日志 + 界面），不可恢复"
                        onClick={() => setConfirmClear(true)}
                    >
                        清空本对话历史消息
                    </button>
                </Show>
            </div>

            {/* 块树滚动区 */}
            <div
                ref={(el) => (scrollRef = el)}
                class="flex-1 overflow-y-auto px-4 py-3"
                onScroll={(e) => setStick(nearBottom(e.currentTarget))}
            >
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
                                    md={md()}
                                />
                            ) : (
                                <div class="text-xs opacity-40">[未知根 {t.tag}]</div>
                            )
                        }
                    </For>
                    <Show when={localChatStore.error}>
                        <div class="text-error text-xs">{localChatStore.error}</div>
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
                        onKeyDown={onEnterKey(() => void submit(), { shiftNewline: true })}
                        onInput={(e) => {
                            // 逐键写内存 + 防抖落盘（draftStore 内部 600ms debounce）
                            const u = uri();
                            if (u) draftStore.set(u, "agent_input", e.currentTarget.value);
                        }}
                    />
                    {/* 按钮 aura 光环只在生成中挂载：停止=error 色跑动画表示"正在跑"，
                        收完流回到"发送"时 aura 随 Show 分支一起卸载，动画自然停止 */}
                    <Show
                        when={!localChatStore.running}
                        fallback={
                            <div class="aura duration-[3s] text-error">
                                <button
                                    class="btn btn-error btn-sm"
                                    onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                >
                                    停止
                                </button>
                            </div>
                        }
                    >
                        <button class="btn btn-primary btn-sm" onClick={() => void submit()}>
                            发送
                        </button>
                    </Show>
                </div>
            </div>

            {/* 清空确认：破坏性且不可恢复，点击与执行之间隔一层确认 */}
            <Show when={confirmClear()}>
                <ConfirmDialog
                    title="清空本对话历史消息？"
                    message={`将删除「${uri() ?? ""}」的全部本地对话记录（消息、思考、工具调用过程），删除后无法恢复。`}
                    confirmLabel="清空"
                    onCancel={() => setConfirmClear(false)}
                    onConfirm={() => {
                        setConfirmClear(false);
                        if (uri()) void localChatStore.clear(uri()!);
                    }}
                />
            </Show>

            {/* 全屏输出 */}
            <Show when={full()}>
                {(f) => <FullscreenModal title={f().title} content={f().content} onClose={() => setFull(null)} />}
            </Show>
        </div>
    );
}

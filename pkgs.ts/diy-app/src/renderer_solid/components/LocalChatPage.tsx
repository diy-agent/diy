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
import { personaStore } from "../store/personaStore";
import { PersonaDrawer } from "./PersonaDrawer";
import { draftStore } from "../store/draftStore";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { Caches, DENSITY_LEVEL, DENSITY_VALUES, type Density } from "../lib/ui-state";
import { MarkdownView } from "./MarkdownView";
import { MdEditor } from "./MdEditor";
import { bylineOf } from "../lib/assistant-byline";
import type { ReasoningEffort } from "../../main/services/local-agent";
// 插话队列项：与草稿同文件存储（任务目录 .diy/drafts.yaml），类型只在 main 侧定义
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { IconExpand, IconCompress, IconTrash, IconGrip, IconClock, IconBolt } from "./icons";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import type { BlockNode } from "../../main/services/local-blocks";
import { INTERRUPTED_TOOL_NOTICE } from "../../main/services/local-blocks";
// 历史 mode 值归一与文案放 shared（纯函数、可单测）：ops 日志是 append-only 的史书，
// 枚举改名前的 step/turn 与现值长期共存，读侧必须归一（详见 shared/steer-mode.ts）
import { steerModeLabel, steerModeTip } from "../../shared/steer-mode";

// ─── 层级 ───────────────────────────────────────────

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
        return !n.stopped ? <span class="text-warning animate-pulse">●</span> : <span>💭</span>;
    }
    const s = str(n.attrs.status);
    if (s === "done") return <span class="text-success">✓</span>;
    if (s === "error") return <span class="text-error">✗</span>;
    // 中断遗留（无 stop、无结果）：不能跟"正在执行"共用同一个点，否则用户看不出历史断在哪
    if (isInterruptedToolBlock(n)) {
        return (
            <span
                class="text-warning"
                title="上一轮中断，没有结果（此行已被收敛为终态，正文与发往模型的同源）"
            >
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

function ToolBody(props: { node: BlockNode; onFull: (title: string, content: string) => void }) {
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
        <div
            class="rounded-lg border border-base-300 bg-base-200/40 text-xs"
            data-block-id={n().id}
            data-block-tag={n().tag}
        >
            <button
                type="button"
                class="flex items-center gap-2 cursor-pointer select-none px-2.5 py-1.5 w-full text-left"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => props.onToggle(n().id)}
            >
                {statusMark(n())}
                <span class="font-medium text-base-content/80 truncate flex-1">
                    {summaryOf(n())}
                </span>
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

/**
 * error 块的外观（唯一出处）。
 *
 * 两个调用点共用：① turn 内的叶子（llm 报错 / 中断 / 超预算）；② **根级** error 块 ——
 * 后者只出现在历史日志里（旧版上限提示没写 parent，fold 后成了根块），
 * 不在这里兜底的话，根渲染分支只会吐一句「[未知根 error]」，用户看不到
 * "还有 N 条插话没投出去"这种关键信息。
 */
function ErrorBox(props: { node: BlockNode }) {
    return (
        <div class="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error whitespace-pre-wrap">
            {`❌ [${str(props.node.attrs.source)}] ${str(props.node.attrs.message)}`}
        </div>
    );
}


/**
 * 回复身份：署名是**该轮事实**的投影，不是当前配置的投影。
 *
 * 原先这里读"当前任务绑定人物 / 缺省"——于是改一次 `personas.yaml` 的 default，
 * 全部历史回复的署名一起被改写（任务 196 实测：ops 首行明明是 mimo-v2.6-flash，
 * 界面却署名「大副 · deepseek-v4.1-flash」）。事实一直在数据里：main 把当轮 model
 * 写进 turn start 的 meta → 落进 `turn.attrs.model`，渲染时读它即可。
 *
 * 旧会话（无该字段）回落到当前人物，但**显式标注为推断**——不假装确定。
 * 与输入框旁那个「跟随缺省（X）」是两回事：那个回答"下一条发给谁"，仍读当前配置。
 */
function AssistantByline(props: { turnModel?: unknown }) {
    const id = () => taskStore.selectedTask?.persona ?? personaStore.idForTask();
    // defOfLive：缓存里没有该 id 时补拉一次（CLI 新建/改名后 renderer 的清单会陈旧）
    const persona = () => personaStore.defOfLive(id());
    const info = () =>
        bylineOf({
            turnModel: props.turnModel,
            personaName: persona()?.name ?? null,
            personaModel: persona()?.model ?? null,
        });
    return (
        <div
            class="mb-1 flex items-center gap-1.5 text-[11px] opacity-70"
            data-testid="assistant-byline"
            data-inferred={info().inferred ? "1" : undefined}
            title={info().title}
        >
            <span
                class="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[12px]"
                aria-hidden="true"
            >
                🤖
            </span>
            {/* 名字只在"当前人物的模型与该轮记录一致"时才敢写：否则宁可只报模型，
                也不能拿别人的名字去顶替（那正是原 bug：署名成了当前配置的投影） */}
            <Show when={info().name}>
                <span class="font-medium">{info().name}</span>
            </Show>
            <Show when={info().model}>
                <span class="opacity-50">·</span>
                <span class="opacity-60">{info().model}</span>
            </Show>
            {/* 旧轮次没有模型记录：说清"这是按当前人物推断的"，别让用户以为界面知道当时是谁答的 */}
            <Show when={info().inferred}>
                <span class="opacity-40">（当时人物未知）</span>
            </Show>
        </div>
    );
}

function LeafView(props: {
    node: BlockNode;
    /** 本轮 turn 的 attrs.model（该轮事实；旧会话可能没有） */
    turnModel?: unknown;
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
        // steer 标记来自 main 写的块 meta（用户在生成中插的话）：标出来，才看得出
        // "这句是在第几步之后插进去的"，而不是以为它是一次新对话的开头
        // 注意类型是 string 而非 SteerMode：值域由**历史日志**决定（含改名前的 step/turn）
        const steer = str(b.attrs.steer);
        return (
            <div class="flex justify-end">
                <div class="max-w-[85%] bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                    <Show when={steer}>
                        <span class="mb-0.5 block text-[10px] opacity-60">
                            ⤵ 插话（{steerModeLabel(steer)}）{steerModeTip(steer)}
                        </span>
                    </Show>
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
                <div>
                    <AssistantByline turnModel={props.turnModel} />
                    <div class="text-sm opacity-80 truncate">
                        {b.stopped ? firstLine(t) : tailLine(t)}
                        <Show when={!b.stopped}>
                            <span class="animate-pulse">▋</span>
                        </Show>
                    </div>
                </div>
            );
        }
        const text = str(b.attrs.content);
        // ⚠️ 必须用 <Show> 而不是 if：LeafView 是组件函数，只在创建时执行一次，
        // 函数体里的 if 分支对 props 变化**不响应**。密度切换之所以看起来是好的，
        // 是因为 segments(density) 变了 → <For> 重建节点；而切 md 不改变 segments，
        // 旧分支会原样留在 DOM 里——现象就是点「MD 原文」正文纹丝不动（只在切任务/重挂载后才生效）。
        return (
            <div>
                <AssistantByline turnModel={props.turnModel} />
                <Show when={props.md} fallback={<PlainText text={text} />}>
                    <MarkdownText text={text} streaming={!b.stopped} />
                </Show>
            </div>
        );
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
        return <ErrorBox node={b} />;
    }
    if (b.tag === "plan") {
        if (props.density === DENSITY_LEVEL.OUTLINE) return null;
        return (
            <div class="text-xs opacity-70">
                📋 计划：
                <For each={(b.attrs.items as unknown[]) ?? []}>
                    {(it) => <div>• {str(it)}</div>}
                </For>
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
                            turnModel={t.attrs.model}
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

// ─── 待发送插话横条 ──────────────────────────────────
//
// 提交的插话在模型取走之前必须**看得见且可取消**：它已经离开输入框（内容进了队列），
// 如果不显示，用户会以为"说过了"，实际可能还排在队列里等下一轮。
// 位置固定在输入区上方一行（与 dsh web 的 queue dock 同语义：队列贴着 composer），
// 而不是混进对话流里 —— 对话流是历史，这条是"还没发生的事"。
//
// 形态：**只渲染插话条目本身**，不另起一行标题（"N 条待发送"这种说明是界面自己在解释自己：
// 用户刚按下「留言」，横条里就是那句话本身，含义不言自明）。
// 每行分三列：**最左 = 拖拽手柄**（图标，按住拖 = 改顺序），**中 = 留言内容**（占满剩余宽度，
// 要发出去的就是这句话），**右 = 排队时机两态开关（时钟 ⇄ 闪电）+ ✕**。
// 默认留言排到下一轮；右侧那个开关可切到下一步，也可再次切回排队。
//
// 顺序：队列是 FIFO 且**顺序即投递顺序**，所以拖拽改的是真实的投递次序（不是显示偏好），
// 松手即落盘（`steer.reorder` 提交完整顺序）。拖拽只认手柄：整行可拖会让"想选中那句话"
// 变成"拖走了它"，而手柄是明确的意图声明（与任务树整行可拖不同 —— 那里一行只有一个含义）。

/** 「留言」按钮的缺省时机：排到下一轮（提交后可在横条上切换）。 */
const DEFAULT_STEER_MODE: SteerMode = "next-turn";

function SteerBar(props: {
    items: SteerItem[];
    onCancel: (id: string) => void;
    onToggleMode: (id: string) => void;
    onReorder: (ids: string[]) => void;
}) {
    /**
     * 拖拽结束：把 source 放到 target 原来的位置，算出**完整的新顺序**再提交。
     *
     * 为什么自己算而不是读 dnd-kit 的 index：语义只看"拖到哪一行上"这一件事，
     * 与 items 数组对得上（id → 下标）；dnd-kit 的 index 是它内部乐观排序后的视图，
     * 拿来做 splice 基准反而要跟它的插件行为对齐。
     */
    const handleDragEnd: NonNullable<DragDropProviderProps["onDragEnd"]> = (event) => {
        // source / target 都可能为 null（拖到空白处松手）：null 即"没落点"，直接放弃
        const from = String(event.operation.source?.id ?? "");
        const onto = String(event.operation.target?.id ?? "");
        if (!from || !onto || from === onto) return;
        const ids = props.items.map((it) => it.id);
        const a = ids.indexOf(from);
        const b = ids.indexOf(onto);
        if (a < 0 || b < 0) return;
        const next = [...ids];
        next.splice(a, 1);
        next.splice(b, 0, from);
        if (next.every((id, i) => id === ids[i])) return; // 顺序没变，不打扰服务端
        props.onReorder(next);
    };

    return (
        <Show when={props.items.length > 0}>
            {/* sensors 只给 PointerSensor：队列排序没有键盘等价操作，键盘传感器会喧宾夺主
                （与任务树同一取舍）。 */}
            <DragDropProvider onDragEnd={handleDragEnd} sensors={[PointerSensor]}>
                <div
                    class="shrink-0 border-t bg-base-200/60 px-3 py-1.5 text-xs"
                    data-steer-bar
                    /* 无可见标题，语义交给 aria-label：读屏与自动化仍能识别这是"待发送的插话" */
                    aria-label={`待发送插话 ${props.items.length} 条`}
                >
                    <ul class="max-h-24 space-y-0.5 overflow-y-auto">
                        <For each={props.items}>
                            {(it) => (
                                <SteerRow item={it} onCancel={props.onCancel} onToggleMode={props.onToggleMode} />
                            )}
                        </For>
                    </ul>
                </div>
                {/* 拖拽幽灵：dnd-kit 的 DragOverlay 是"跟手的那一份"，原行留在原地（半透明）——
                    必须给：不给的话反馈走 clone 分支，会在 DOM 里插一份带 data-steer-id 的克隆
                    节点（列表断言与无障碍树都会被污染，实测踩过）。 */}
                <DragOverlay>
                    {(source) =>
                        source?.data?.text ? (
                            <div class="flex items-center gap-2 rounded border bg-base-100 px-2 py-1 text-xs shadow-lg opacity-90 select-none pointer-events-none">
                                <IconGrip class="h-3.5 w-3.5 opacity-40" />
                                <span class="max-w-[320px] truncate">{String(source.data.text)}</span>
                            </div>
                        ) : null
                    }
                </DragOverlay>
            </DragDropProvider>
        </Show>
    );
}

function SteerRow(props: {
    item: SteerItem;
    onCancel: (id: string) => void;
    onToggleMode: (id: string) => void;
}) {
    // 行 = 拖拽源 + 放置目标；**只有手柄能发起拖拽**（整行可拖会让"想选中那句话"变成"拖走了它"）。
    // ⚠️ 手柄必须用 handleRef（内部是 signal + effect 驱动），不能用 `handle: el` 那种普通变量：
    // 首次渲染时它还是 undefined，之后的赋值不会让 dnd-kit 重新注册（没有响应式来源）。
    const drag = useDraggable({
        get id() {
            return props.item.id;
        },
        // getter：拖拽幽灵要显示这句话本身，改名/换项时跟着刷新（与任务树同一写法）
        get data() {
            return { text: props.item.text };
        },
    });
    const drop = useDroppable({
        get id() {
            return props.item.id;
        },
    });
    const ref = (el: Element | undefined) => {
        drag.ref(el);
        drop.ref(el);
    };
    const it = () => props.item;
    /** 时机开关的 DOM 引用：切换失败时用它把受控值写回 */
    let toggleEl: HTMLInputElement | undefined;
    // ⚠️ 这个 effect 必须建在**组件体**里（只建一次），不能塞进 ref 回调 ——
    // ref 回调会被调用多次，每次都会多出一个 effect（泄漏 + 重复写 DOM）。
    //
    // 它存在的唯一理由：checkbox 是**受控**的，而用户点击时浏览器已经先改了 DOM。
    // RPC 失败时快照不变 → Solid 算出的属性值跟上次相同 → 不写 DOM → 开关停在用户点出的
    // 那一侧，而盘上仍是原值（界面"已加急"、实际排队中 —— 显示假值）。
    // 订阅 steerToggleTick 让**失败时必定重跑**；正常路径下算出的值与真实一致，写回是无操作。
    createEffect(() => {
        // 这一行是**故意的**响应式订阅（不是笔误）：tick 变化 → effect 重跑 → 把 DOM 写回真实
        // 状态。裸表达式没有别的用途，故显式豁免该 lint 规则 —— 换成 `void` 或赋给变量都会
        // 换来另一条 warning（no-unused-vars），反而更绕。
        // oxlint-disable-next-line no-unused-expressions
        localChatStore.steerToggleTick;
        const el = toggleEl;
        if (el) el.checked = props.item.mode === "next-step";
    });
    return (
        <li
            ref={ref}
            class={`flex items-center gap-2 rounded transition-colors ${
                drag.isDragSource() ? "opacity-40" : ""
            } ${drop.isDropTarget() ? "bg-primary/10 ring-1 ring-primary/40 ring-inset" : ""}`}
            data-steer-id={it().id}
        >
            {/* 最左：拖拽手柄（按住可拖，改投递顺序） */}
            <span
                ref={drag.handleRef}
                class="tooltip tooltip-right shrink-0 cursor-grab text-base-content/40 hover:text-base-content/80 active:cursor-grabbing"
                aria-label={`拖动调整顺序（${it().text}）`}
                data-tip="拖动调整投递顺序"
                data-steer-handle
            >
                <IconGrip class="h-3.5 w-3.5" />
            </span>
            {/* 中：留言本身 —— 占满剩余宽度，截断在尾部（要发出去的是这句话） */}
            <span class="min-w-0 flex-1 truncate" title={it().text}>{it().text}</span>
            {/* 右：排到哪一轮的两态开关（daisyUI swap，可逆）。
                两态**同时改形状与颜色**，不能只换色 —— 小图标上"同一个形状换个颜色"扫一眼分不出：
                  · 下一轮（默认）：时钟 + 弱色 = "还得等"
                  · 下一步（加急）：闪电 + warning 高对比底色/描边 + 呼吸 = "马上插进去"
                形状不同，不读 tooltip 也能分辨；动画只作用于图标，不动整行布局。 */}
            <label
                class={`btn btn-xs shrink-0 swap tooltip tooltip-left ${
                    it().mode === "next-step"
                        ? "border-warning/60 bg-warning/15 text-warning hover:bg-warning/25"
                        : "btn-ghost text-base-content/45 hover:text-base-content/80"
                }`}

                data-tip={
                    it().mode === "next-turn"
                        ? "排到下一轮（点击改为马上插到下一步）"
                        : "已加急：马上插到下一步（点击改回排队）"
                }
                aria-label={
                    it().mode === "next-turn"
                        ? "排到下一轮（点击改为马上插到下一步）"
                        : "已加急：马上插到下一步（点击改回排队）"
                }
                data-steer-toggle={it().id}
            >
                <input
                    type="checkbox"
                    ref={(el) => (toggleEl = el)}
                    checked={it().mode === "next-step"}
                    onChange={() => props.onToggleMode(it().id)}
                />
                <IconClock class="swap-off h-4 w-4" />
                <IconBolt class="swap-on h-4 w-4 animate-pulse drop-shadow" />
            </label>
            <button
                class="btn btn-ghost btn-xs shrink-0"
                aria-label="取消这条插话"
                data-tip="取消（不会发送）"
                onClick={() => props.onCancel(it().id)}
            >
                ✕
            </button>
        </li>
    );
}

// ─── 全屏输出 ───────────────────────────────────────

function FullscreenModal(props: { title: string; content: string; onClose: () => void }) {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation(); // 同上：别让 TaskDetailPanel 的 Esc 顺手把面板也关了
            props.onClose();
        }
    };
    onMount(() => document.addEventListener("keydown", onKey, true));
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
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
    let cancelRef: HTMLButtonElement | undefined;
    const onKey = (e: KeyboardEvent) => {
        // 只拦 Esc；不拦 Enter —— 焦点默认在「取消」上，回车本就是取消（原生行为），
        // 而 Tab 到「清空」后回车应能正常确认：全局拦 Enter 会把这条路一起掐掉。
        if (e.key === "Escape") {
            e.stopPropagation();
            props.onCancel();
        }
    };
    onMount(() => {
        // ⚠️ 不能用 HTML autofocus：它只在文档加载时生效，动态插入的节点上无效
        // （实测焦点留在原按钮上，回车会误触原按钮）。必须主动 focus。
        cancelRef?.focus();
        // 捕获阶段 + stopPropagation：弹窗开着时 Esc 只该关弹窗。
        // TaskDetailPanel 也在 window 上监听 Esc 关整个详情面板（冒泡阶段），
        // 不拦的话一次 Esc 会连面板一起关掉（弹窗和面板双杀）。
        document.addEventListener("keydown", onKey, true);
    });
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
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
                    <button
                        class="btn btn-xs"
                        ref={(el) => (cancelRef = el)}
                        onClick={props.onCancel}
                    >
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

export function LocalChatPage(props: { uri?: string }) {
    // 执行页显式传入 uri；不能依赖全局 selectedUri，否则任务详情还在异步加载时，
    // 页面可能显示“选择任务”但聊天仍沿用上一个任务的会话，形成串台。
    const uri = () => props.uri ?? taskStore.selectedUri ?? null;
    const [inputValue, setInputValue] = createSignal("");
    const [densityOpen, setDensityOpen] = createSignal(false);
    const [personaPanelOpen, setPersonaPanelOpen] = createSignal(false);
    const [fullscreen, setFullscreen] = createSignal(false);
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
        void localChatStore
            .open(u)
            .catch(() => undefined)
            .then(() => {
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
        setInputValue(draftStore.get(u, "agent_input"));
    };
    // 首挂（切页面/组件重建，TaskState 在内存保留）：恢复当前任务阅读位置 + 输入框草稿
    onMount(() => {
        // 人物清单：按钮要显示"这条消息发给谁"；未加载时显示"加载中…"而不是"未加载"
        // （后者看着像功能坏了，而其实会话完全可用 —— 自相矛盾的界面）
        void personaStore.load();
        const closePopovers = (e: MouseEvent) => {
            const target = e.target as Element;
            if (!target.closest("[data-density-control]")) setDensityOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setDensityOpen(false);
                setPersonaPanelOpen(false);
                setFullscreen(false);
            }
        };
        document.addEventListener("click", closePopovers);
        document.addEventListener("keydown", onKey, true);
        onCleanup(() => {
            document.removeEventListener("click", closePopovers);
            document.removeEventListener("keydown", onKey, true);
        });
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

    // ─── agent 人物（模型/参数/行为指令都在人物定义里，这里只选"要谁干活"）───
    /** 本任务当前人物：任务绑定是权威（清单在 personaStore，未加载完时先用缺省名，不显示空） */
    const personaDef = () => personaStore.defOfLive(personaStore.idForTask());

    // 换绑与改定义都在人物面板里做（那里能看见"影响多少任务"）——这里只负责打开它。
    // 为什么不做成下拉快速切换：人物是**全局配置实体**，下拉只够"选"，看不见改动的波及面。

    const submit = async () => {
        const text = inputValue().trim();
        if (!text || !uri() || localChatStore.running) return;
        setInputValue("");
        // 内容已作为消息发出，草稿使命结束：清掉，避免下次进入看到已发送的旧文本
        void draftStore.clear(uri()!, ["agent_input"]);
        setStick(true); // 刚发出，必然想看回复：无视之前是否在上方阅读
        await localChatStore.send(uri()!, text);
    };

    /**
     * 提交插话：内容**不离开视野**——清空输入框，但队列横条立刻显示出这条待发送内容。
     *
     * 失败时保留输入框内容（用户的话不能既没进队列、又被打字清空）。
     */
    const submitSteer = async (mode: SteerMode) => {
        const text = inputValue().trim();
        const u = uri();
        if (!text || !u) return;
        if (!(await localChatStore.submitSteer(u, mode, text))) return;
        setInputValue("");
        // 已入队：草稿使命结束（草稿语义是"还没提交的输入"，这条已经提交了）
        void draftStore.clear(u, ["agent_input"]);
    };

    /** 回车分流：生成中 = 留言，否则正常发送 */
    const submitByEnter = () => {
        if (localChatStore.running) void submitSteer(DEFAULT_STEER_MODE);
        else void submit();
    };

    const cancelSteer = (id: string) => {
        const u = uri();
        if (u) void localChatStore.cancelSteer(u, id);
    };

    const toggleSteerMode = (id: string) => {
        const u = uri();
        if (u) void localChatStore.toggleSteerMode(u, id);
    };

    const reorderSteers = (ids: string[]) => {
        const u = uri();
        if (u) void localChatStore.reorderSteers(u, ids);
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            <PersonaDrawer open={personaPanelOpen()} onClose={() => setPersonaPanelOpen(false)} />
            {/* 顶部：对话 view 的**视图级控制**（Markdown 显示方式 + 信息密度 + 清空本会话历史）。
                pr-16：ViewGrid 的 area 设施（最大化/最小化）浮在本区域**右上角**，
                不预留这条空档，按钮会与它叠在同一坐标上（实测重叠）。 */}
            <div
                class={`flex items-center justify-end gap-2 pl-4 pr-16 ${VIEW_BAR_H} border-b shrink-0`}
            >
                {/* 清空本对话历史：破坏性且不可恢复 —— 只给图标（配 tooltip）+ 二次确认，
                    危险按钮从输入区挪到这里：输入区那排是"发送/留言"的动作区，
                    清空历史与它们不同类（不是本轮动作，而是全会话的删除）。
                    生成中不显示：正跑着的会话不该在此时被清掉（原行为不变）。 */}
                <Show when={!localChatStore.running}>
                    <button
                        class="btn btn-ghost btn-xs tooltip tooltip-bottom"
                        data-tip="清空本对话历史（不可恢复）"
                        aria-label="清空本对话历史"
                        onClick={() => setConfirmClear(true)}
                    >
                        <IconTrash class="h-4 w-4" />
                    </button>
                </Show>
                <div class="relative" data-density-control>
                    <button
                        class="btn btn-ghost btn-xs tooltip tooltip-bottom"
                        data-tip="信息密度（拖到最右看全部过程）"
                        aria-label="信息密度"
                        onClick={(e) => {
                            e.stopPropagation();
                            setDensityOpen((v) => !v);
                        }}
                    >
                        ☷
                    </button>
                    <Show when={densityOpen()}>
                        <div
                            class="absolute right-0 top-full z-20 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl"
                            data-density-control
                            onClick={(e) => e.stopPropagation()}
                        >
                            <input
                                type="range"
                                min="1"
                                max="4"
                                step="1"
                                class="range range-primary range-xs"
                                value={DENSITY_VALUES.indexOf(density()) + 1}
                                aria-label="信息密度"
                                onInput={(e) =>
                                    setDensity(DENSITY_VALUES[Number(e.currentTarget.value) - 1]!)
                                }
                            />
                            <div class="mt-1 flex justify-between text-[10px] opacity-60">
                                <span>简</span>
                                <span>详</span>
                            </div>
                        </div>
                    </Show>
                </div>
                {/* 显示方式二选一：两个选项都可见、当前态高亮 —— 单按钮式「MD」看不出
                    处于哪一态（切回去要猜），且与破坏性按钮同形时易误点。 */}
                <div class="join shrink-0" role="group" aria-label="Markdown 显示方式">
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
                            ) : t.tag === "error" ? (
                                /* 遗留的**根级** error 块（历史日志：旧版上限提示未挂 parent）。
                                   新日志已把提示挂进 turn（见 local-agent 的上限分支），但重放旧
                                   ops.jsonl 时根块仍会出现 —— 必须能读懂，不能只吐「[未知根 error]」 */
                                <ErrorBox node={t} />
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

            {/* 待发送插话横条（正常态）：贴着输入区上方一行 —— 队列是"还没发生的事"，
                不该混进上面的对话流（那里是历史） */}
            <Show when={!fullscreen()}>
                <SteerBar
                    items={localChatStore.steers}
                    onCancel={cancelSteer}
                    onToggleMode={toggleSteerMode}
                    onReorder={reorderSteers}
                />
            </Show>

            {/* 输入框：Markdown 源码编辑、随内容增长，控制项置于框内底部。 */}
            <div class="border-t p-3 shrink-0">
                {/* 定位类必须二选一：Tailwind 里 `relative` 排在 `fixed` 之后，
                    两个同时挂上会让 `fixed` 失效（实测全屏退化成原地 147px 高）。

                    底色用 base-200 —— 也就是编辑器里"当前行"的那档加深色：整块（正文 + 底部
                    工具条）连成一片，读起来是"一个凹进去的输入区"，而不是白底卡片上贴一条按钮。
                    编辑器侧同步传 `embedded`，让它的纸面透明、当前行再深一档（base-300）。

                    边框照抄 daisyUI `.input` 的 token 语义（它是 5.x 里唯一的**容器式**输入控件：
                    `.input input { border:none }` + `:focus-within` 联动）。多行编辑器 + 底部工具条
                    装不进 `.input`（单行 `height:var(--size)`）也装不进 `.textarea`（非 flex，且
                    textarea 无子元素），故手写容器但复用同一套变量：
                      · 静息：`--input-color` = base-content 20% → `border-base-content/20`
                      · 聚焦：`--input-color` = base-content → `focus-within:border-base-content`
                        **只变色、不加 outline**：outline 画在 border 外侧 2px，看着像"多了一圈
                        边框"（实测双边框感），边框自己变色就够表达了。
                      · 圆角：`--radius-field`（输入类控件语义，比 `--radius-box` 更方正） */}
                <div
                    class={`rounded-field border border-base-content/20 bg-base-200 transition-colors focus-within:border-base-content ${fullscreen() ? "fixed inset-4 z-40 flex min-h-0 flex-col p-4" : "relative"}`}
                >
                    {/* 全屏时横条挪进这块 fixed 区域顶部：正常态那份被遮罩盖住看不见，
                        同一时刻只有一处渲染（同一份数据不重复画） */}
                    <Show when={fullscreen()}>
                        <div class="rounded-field border border-base-300 mb-2">
                            <SteerBar
                                items={localChatStore.steers}
                                onCancel={cancelSteer}
                                onToggleMode={toggleSteerMode}
                                onReorder={reorderSteers}
                            />
                        </div>
                    </Show>
                    {/* 全文编辑开关：输入框**右上角**，daisyUI swap（小↔大 双向动画）。
                        用 label+checkbox 而不是 button：swap 的语义就是「两种状态的开关」。 */}
                    <label
                        class="btn btn-ghost btn-xs swap swap-rotate absolute right-1 top-1 z-10 tooltip tooltip-left"
                        data-tip={fullscreen() ? "退出全文编辑（Esc）" : "全文编辑（放大）"}
                        aria-label={fullscreen() ? "退出全文编辑" : "全文编辑"}
                    >
                        <input
                            type="checkbox"
                            checked={fullscreen()}
                            onChange={(e) => setFullscreen(e.currentTarget.checked)}
                        />
                        {/* 与 area chrome 共用同一套图标（四角外/内），不再内联重复 path */}
                        <IconExpand class="swap-off h-4 w-4" />
                        <IconCompress class="swap-on h-4 w-4" />
                    </label>
                    {/* pr-8：正文不要钻到右上角按钮底下 */}
                    <div
                        class={`min-h-0 overflow-auto px-2 pt-2 pr-8 ${fullscreen() ? "flex-1" : "min-h-[72px] max-h-[320px]"}`}
                    >
                        <MdEditor
                            value={inputValue()}
                            /* ⚠️ 输入框**不因生成中而锁死**。理由有两条，第二条是硬约束：
                                 ① 锁输入框只是"别发"的视觉暗示，真正的守门在 submit()
                                    （`if (live) return`）与 main 侧的并发拒发 —— 锁住它并不能多防住
                                    什么，却会让人打好的字没法留存；
                                 ② 插话（"插嘴"）的前提就是**能打字**：旧行为把输入框锁死，
                                    等于强迫用户等模型跑完，本轮次的插话需求无从表达。
                               onEnter 按状态分流：生成中 = 留言，否则 = 发送（见 submitByEnter）。 */
                            editable
                            onChange={(v) => {
                                setInputValue(v);
                                const u = uri();
                                if (u) draftStore.set(u, "agent_input", v);
                            }}
                            onEnter={submitByEnter}
                            wrap
                            lineNumbers={fullscreen()}
                            embedded
                            class="min-h-[56px]"
                        />
                    </div>
                    {/* 不再画分隔线：正文与工具条同底色（base-200），一条 border-base-300 的横线
                        会在"一体化"的块里切出一道比底色更亮/更暗的缝，比没有线更显割裂。 */}
                    <div class="flex shrink-0 items-center gap-2 px-2 py-2 text-xs">
                        {/* 人物入口：打开人物面板（选/改/换绑都在那里）。
                            按钮本身显示**本任务当前用谁 + 它的模型与档位** ——
                            "我这条消息会发给哪个模型"必须一眼可见，不用点开才知道。 */}
                        <button
                            class="btn btn-ghost btn-xs max-w-[280px] min-w-0 tooltip tooltip-top"
                            data-tip="agent 人物：选择绑定 / 跟随缺省，编辑模型与参数（改人物会影响所有引用它的任务）"
                            aria-label="打开 agent 人物面板"
                            onClick={(e) => {
                                e.stopPropagation();
                                setPersonaPanelOpen(true);
                            }}
                        >
                            <span class="truncate">
                                {/* 跟随缺省时显式写出来：「谁在干活」与「是不是我固定绑的」是两件事，
                                    只显示人物名会让人以为"这个任务固定用了它"，而其实缺省一改就跟着变 */}
                                <Show when={personaStore.isFollowing()}>
                                    <span class="badge badge-xs badge-ghost mr-1">跟随缺省</span>
                                </Show>
                                {personaDef()?.name ?? "选择人物"}
                                <span class="opacity-60">
                                    （
                                    {personaDef()
                                        ? `${personaDef()!.model} · ${reasoningEffortLabel(personaDef()!.reasoningEffort as ReasoningEffort)}`
                                        : "加载中…"}
                                    ）
                                </span>
                            </span>
                            <span class="opacity-50">⚙</span>
                        </button>
                        <div class="flex-1" />
                        {/* 生成中：只有一个「留言」（+ 原「停止」）。
                            只在**输入框有内容**时才出现 —— 没打字就没得留，空按钮只会占位。
                            投递时机不在这里选：它是每条留言的去向，提交后到上方横条上切换
                            （输入区多摆一个控件，等于每次发言前都逼用户先决定"投哪个"）。
                            「停止」的外观/位置/行为一律不动：它是打断，不该因为新功能而变样。 */}
                        <Show when={localChatStore.running}>
                            <Show when={inputValue().trim()}>
                                <button
                                    class="btn btn-outline btn-xs tooltip tooltip-top"
                                    data-tip="留言：排到下一轮（回车同此）。想让它马上生效，提交后点上方那条的闪电图标"
                                    onClick={() => void submitSteer(DEFAULT_STEER_MODE)}
                                >
                                    留言
                                </button>
                            </Show>
                            <div class="aura text-error rounded-full" style={{ "--aura-padding": "2px", "--tw-duration": "2.4s" }}>
                                <button
                                    class="btn btn-error btn-sm tooltip tooltip-top"
                                    data-tip="中断本轮生成（保留已产出内容）"
                                    onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                >
                                    停止
                                </button>
                            </div>
                        </Show>
                        <Show when={!localChatStore.running}>
                            <button
                                class="btn btn-primary btn-sm tooltip tooltip-top"
                                data-tip="发送（回车发送 / Shift+回车换行）"
                                onClick={() => void submit()}
                            >
                                发送
                            </button>
                        </Show>
                    </div>
                </div>
            </div>

            {/* 清空确认：破坏性且不可恢复，点击与执行之间隔一层确认 */}
            <Show when={confirmClear()}>
                <ConfirmDialog
                    title="清空本对话历史消息？"
                    /* ⚠️ 必须点明插话也被删：main 的 clear() 会一并清空插话队列
                       （local-agent 的 queue.clear），而插话与草稿同级 —— 属"丢了 = 用户白打"的
                       不可重建数据。只写"对话记录"会让用户在不知情下丢掉排队中的留言。 */
                    message={`将删除「${uri() ?? ""}」的全部本地对话记录（消息、思考、工具调用过程）${
                        localChatStore.steers.length > 0
                            ? `，以及排队中的 ${localChatStore.steers.length} 条插话`
                            : ""
                    }，删除后无法恢复。`}
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
                {(f) => (
                    <FullscreenModal
                        title={f().title}
                        content={f().content}
                        onClose={() => setFull(null)}
                    />
                )}
            </Show>
        </div>
    );
}

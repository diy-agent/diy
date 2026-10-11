/**
 * LocalChatPage — 本地自定义 agent 对话页（ai-sdk 块协议，独立于 ACP ChatPage）
 *
 * 渲染 = f(轮次展开级别 level, 阶段 phase)。静态（已截止）与动态（进行中）**结构同构**，
 * 动态只是在轮尾多一块实时区。
 *
 * 一个 turn 的形状（[ ] = 阶段出现的东西）：
 *   [轮首用户发言]           ← 先出：IM 直觉是"用户先说、对方再接"
 *   轮次头（人物标题 bar）    🤖 + 人物/模型/思考级别 + 统计 + 开合箭头（点它 = 收拢/展开这一轮）
 *   内容区（按级别）          1 结论摘要 · 2 结论全文 · 3 + 紧凑行 · 4 紧凑行铺开逐条
 *   [轮尾实时区]             仅直播中：当前那一步的展开体，固定高度（见 LiveAreaView）
 *   轮尾一行                 时刻（左，纯文本，不可点）+ 用量按钮（右，hover 卡 / 点击明细）
 *
 * 级别（`lib/chat-fold` 的 TurnLevel）：
 *   1 摘要结论 → 2 完整结论 → 3 紧凑过程 → 4 全部展开。
 *   **循环只归顶部那个 `n/4 展开` 按钮**（对所有轮次一起换层）；
 *   点某一轮的人物标题 bar 只是"把我这一条收拢 / 展开"两态（用户 2026-10-11 口径：
 *   单条信息不做循环），见 `levelOfTurn`。
 * **第 5 层（单条工具/思考的内容）不在级别里**：太庞大，只由用户点那一行自己开（procOpen）。
 *
 * ⚠️ 根行（每个 turn 一行）**按 id 复用行对象**（见 rootRows 与本文件的 turnById）：
 *   `<For>` 按引用判定同一行，而直播轮的块树节点每帧都是新对象 —— 直接喂 `trees` 会让
 *   整轮 DOM 每帧重建，后果不是"卡"而是**点击全丢**（浏览器不给"按下/松开落在不同元素上"
 *   的手势派发 click，连祖先都不冒泡；2026-10-11 CDP 实测）。
 *
 * 恒显项（与级别无关）：用户发言（"我说过啥"的脉络本体）、error 块、轮尾时刻与用量、直播实时区。
 * 被压成摘要的正文必须**看得出被裁过**（底部渐隐 + 可点提示行，见 ConclusionText）。
 * 「开/关」一律由 `IconChevron`（daisyUI collapse-arrow 同形：收起下指、展开上指）表达，
 * 可展开行头一律 `DisclosureHead`（div + role=button：**按钮内的文本选不中**，见其头注）。
 * 「显示什么、按什么序、开到第几层」的语义全在 `lib/chat-fold.ts`（纯函数 + 单测），本文件只管画。
 * MD 渲染/原文是**正交**的显示偏好：摘要态同样按它渲染（2026-10-11 反馈，见 ConclusionText）。
 */
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { personaStore } from "../store/personaStore";
import { PersonaDrawer } from "./PersonaDrawer";
import {
    TurnUsageBar,
    TurnUsageDetailDrawer,
    SessionUsageChip,
    WindowRing,
    UsageDrawer,
    UsageHoverCard,
    armHoverClose,
    cancelHoverClose,
    type UsageHoverState,
} from "./UsagePanel";
import { CompactHistoryPanel } from "./CompactSessionPanel";
import { draftStore } from "../store/draftStore";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { Caches } from "../lib/ui-state";
import { MarkdownView } from "./MarkdownView";
import { MdEditor } from "./MdEditor";
import { bylineOf } from "../lib/assistant-byline";
import type { ReasoningEffort } from "../../main/services/local-agent";
// 插话队列项：与草稿同文件存储（任务目录 .diy/drafts.yaml），类型只在 main 侧定义
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { IconExpand, IconCompress, IconTrash, IconGrip, IconClock, IconBolt, IconChevron } from "./icons";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import type { BlockNode } from "../../main/services/local-blocks";
import { INTERRUPTED_TOOL_NOTICE } from "../../main/services/local-blocks";
// 折叠 / 展开级别语义（纯函数，可单测）：显示什么、按什么序、开到第几层 —— 本文件只消费结果
import {
    DEFAULT_TURN_LEVEL,
    TURN_LEVEL_MAX,
    TURN_LEVEL_MIN,
    clampLines,
    contentItems,
    cycleTurnLevel,
    foldedItems,
    isTurnLevel,
    isUserText,
    leadUsers,
    leavesOf,
    levelOfTurn,
    liveAreaOf,
    planOfLevel,
    turnFoldTip,
    turnLevelTip,
    type ContentItem,
    type LiveArea,
    type TurnLevel,
} from "../lib/chat-fold";
// 历史 mode 值归一与文案放 shared（纯函数、可单测）：ops 日志是 append-only 的史书，
// 枚举改名前的 step/turn 与现值长期共存，读侧必须归一（详见 shared/steer-mode.ts）
import { steerModeLabel, steerModeTip } from "../../shared/steer-mode";

// ─── 层级 ───────────────────────────────────────────



// ─── 小工具 ─────────────────────────────────────────

/**
 * 可展开行头（disclosure）。**不能用 `<button>`** —— Chromium 里表单控件内的文本一律不可选中
 * （UA 样式强制 `user-select: none`），而用户要能拖选轮次标题里的模型名 / 工具命令去复制
 * （2026-10-04 反馈：左侧任务详情的标题能选、这里选不中）。故改用 `div` + `role="button"`：
 * Enter / Space 等价可操作，语义不变而文本可选。
 *
 * 同理**不做 `onPointerDown` preventDefault**：那是旧版为"点击不误选"加的，
 * 与"文本可选中"直接冲突（它会把拖选一并吃掉）。
 */
function DisclosureHead(props: {
    open: boolean;
    onToggle: () => void;
    class?: string;
    /** 读屏文案（可选；不给则由子内容文本承担） */
    ariaLabel?: string;
    /** 静态描述位透传（data-* / title）。role / aria-expanded / class / 事件由本组件自己管，不接受覆盖 */
    rest?: Record<string, string | undefined>;
    children: JSX.Element;
}) {
    return (
        <div
            {...props.rest}
            role="button"
            tabindex={0}
            class={`cursor-pointer ${props.class ?? ""}`}
            aria-expanded={props.open}
            aria-label={props.ariaLabel}
            onClick={() => props.onToggle()}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onToggle();
                }
            }}
        >
            {props.children}
        </div>
    );
}

const firstLine = (s: string) => {
    const i = s.indexOf("\n");
    return i === -1 ? s.slice(0, 90) : s.slice(0, i);
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
        <div class={`whitespace-pre-wrap break-words text-prose leading-relaxed ${props.class ?? ""}`}>
            {props.text}
        </div>
    );
}

/** assistant 正文（Markdown 富文本）：与原文模式共用同一数据源，仅渲染方式不同 */
function MarkdownText(props: { text: string; streaming: boolean }) {
    return <MarkdownView content={props.text} streaming={props.streaming} />;
}

/**
 * 按 id 现取轮次节点。
 *
 * 为什么是"现取"而不是"把节点当值传下去"：行对象按 id 复用（见页面里 rootRows 的注释），
 * 而块树每帧都会给出新节点 —— 节点必须从信号里现读，传值就是传一份会过期的快照。
 * 取不到（行正在被移除）时给空轮次，不让渲染期炸掉。
 */
const EMPTY_TURN: BlockNode = { tag: "turn", id: "", stopped: true, touched: 0, attrs: {}, children: [] };
function turnById(id: string): BlockNode {
    return localChatStore.trees.find((t) => t.id === id) ?? EMPTY_TURN;
}

// ─── 树工具（文档序） ───────────────────────────────

/** 本轮是否已出现助理侧内容（think/tool/text-assistant/error/plan）。
 *  发送后到首个助理事件之间有一段真空期（握手 + 上游首 token 往返），
 *  此时界面上只有 user 气泡，需要 loading 图标填充"正在处理"的反馈；
 *  一旦助理内容出现即让位给真实消息（含流式思考过程）。 */
function hasAssistantContent(turn: BlockNode): boolean {
    return leavesOf(turn).some((n) => !isUserText(n));
}
/**
 * 中间区的**身份复用**：`contentItems` 每次（每帧）都返回一组新对象，直接喂 `<For>` 就是
 * 每帧把整轮重建 —— 后果见文件头注（点击全丢）。行对象按 key + 结构（同引用）复用，
 * DOM 才留在原地。
 *
 * 用**引用相等**做判据的依据与 `toTree` 的缓存一致：未变的块在块树里就是同一个对象，
 * 于是"内容没变" ⟺ "节点逐个同引用"。
 */
function sameItem(a: ContentItem, b: ContentItem): boolean {
    if (a.kind !== b.kind || a.key !== b.key) return false;
    if (a.kind === "row" && b.kind === "row") {
        return (
            a.text === b.text &&
            a.parts.length === b.parts.length &&
            a.parts.every((n, i) => n === b.parts[i])
        );
    }
    return a.kind !== "row" && b.kind !== "row" && a.node === b.node;
}

/** 按位复用同形项（新数组，但元素尽量沿用旧对象 —— 元素的引用相等正是 `<For>` 的 diff 依据） */
function reuseItems(prev: ContentItem[], next: ContentItem[]): ContentItem[] {
    return next.map((s, i) => {
        const p = prev[i];
        return p && sameItem(p, s) ? p : s;
    });
}

/**
 * 中断的 tool 块：
 *   ① 显式终态 status=interrupted（main 已收敛并写进 ops）→ 直接读，不靠推断
 *   ② 兼容旧会话：未收 stop 且该任务**此刻确实没有轮次在跑**（历史日志里还没收敛）
 *
 * ⚠️ 判据必须是 main 真值 `live`（含别人发起的轮次），不能用本地 `running`：
 *    本地 running 只代表"我这轮在等自己的流" —— 拿它当整体运行态，会把 CLI 正在跑的
 *    一轮判成"中断的历史"（任务 194 现象一）。也不能反过来把"未收 stop"当成直播中
 *    （那会让真崩溃/中断的历史不再可见）。
 */
function isInterruptedToolBlock(n: BlockNode): boolean {
    if (n.tag !== "tool") return false;
    const s = str(n.attrs.status);
    if (s === "interrupted") return true;
    if (n.stopped) return false;
    if (s === "done" || s === "error") return false;
    return !localChatStore.live;
}

/**
 * 展开判定（2026-10-04 重写）：**pin 是用户的显式覆盖，档位只给默认值**。
 *
 * 正文与过程分两套默认：
 *   · 正文：pin → L2/L3 默认展开、L1 折成一行（**直播中同样折叠** —— L1 的语义就是
 *     "只看最后一行"，收起态仍显示正在写的那一行 + 光标，进度照样可见）；
 *   · 过程：error 块 / 中断遗留 tool 恒开（看"断在哪"）→ pin → 一律默认收起
 *     （原 L4「全开」档已取消 —— 档位不再负责"帮用户全开"）。
 */
function procOpen(n: BlockNode, pin: Record<string, boolean>): boolean {
    if (n.tag === "error") return true;
    if (n.tag === "tool" && str(n.attrs.status) === "error") return true;
    if (isInterruptedToolBlock(n)) return true;
    if (n.id in pin) return pin[n.id]!;
    return false;
}

// ─── 行摘要与正文 ───────────────────────────────────

function toolCommand(n: BlockNode): string {
    const args = n.attrs.args as { command?: string; path?: string } | undefined;
    if (args?.command) return args.command;
    if (args?.path) return `read ${args.path}`;
    return str(n.attrs.title);
}

/**
 * 过程行的标题。`open` 参与：**思考行收起时预览首行**（一眼看出在琢磨什么），
 * 展开后只写"思考" —— 否则标题那句与下方正文的第一行是同一句，同一屏里看两遍
 *（2026-10-11 用户口径：展开后只显示"思考"）。
 */
function summaryOf(n: BlockNode, open = true): string {
    if (n.tag === "think") {
        const label = n.stopped ? "思考" : "思考中…";
        if (open) return label;
        return firstLine(str(n.attrs.content)).trim() || label;
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

function ToolBody(props: {
    node: BlockNode;
    onFull: (title: string, content: string) => void;
    /** true = 画在轮尾活动框里（活的那个工具）：命令行恒给出、内层不再自己滚 */
    live?: boolean;
}) {
    const n = props.node;
    const output = () => str(n.attrs.output);
    const pv = () => previewLines(output());
    const title = () => `${str(n.attrs.tool)} · ${toolCommand(n)}`;
    // 命令行只在**多行或超长**时才在展开体重列：折叠行已显示命令首行，
    // 单行短命令再列一遍就是同一句看两遍（用户 2026-10-04 反馈的重复）。
    // 例外：活动框里**恒给**（那里没有"上一行标题"可看，且高度是固定的，
    // 空着一块会以为坏了 —— 2026-10-11 反馈「工具输出没像思考那样进活动框」）。
    const cmdNeedsFull = () => {
        if (props.live) return true;
        const c = toolCommand(n);
        return c.includes("\n") || c.length > 80;
    };
    return (
        <div class="space-y-1 font-mono" data-tool-body>
            <Show when={cmdNeedsFull()}>
                <pre class="text-base-content/70">$ {toolCommand(n)}</pre>
            </Show>
            <Show when={output()}>
                {/* live：内层不设 max-h/overflow —— 外面那层就是唯一的滚动容器，
                    两层各自滚动会出现"滚不动"的错觉（实测：内层吃掉滚轮） */}
                <pre
                    class={`whitespace-pre-wrap bg-base-100/60 rounded p-2 ${props.live ? "" : "max-h-72 overflow-auto"}`}
                >
                    {pv().text}
                </pre>
            </Show>
            {/* 工具返回前的结果区是**真空**（ai-sdk 只在 tool-result 一次给全量 stdout），
                固定高度的框里说明白"在等什么"，否则看着像卡住 */}
            <Show when={props.live && !n.stopped && !output()}>
                <div class="animate-pulse text-base-content/50">⋯ 执行中，等待工具返回…</div>
            </Show>
            {/* 中断遗留：正文显示与发往 LLM 完全同源的占位说明（不再是空白让人无从下手） */}
            <Show when={isInterruptedToolBlock(n)}>
                <div class="alert alert-warning alert-soft text-body py-2 font-sans">
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

/** 过程块正文（think 原文 / tool 输出）：**折叠行与实时区共用同一份渲染** ——
 *  两处各写一遍就会出现"实时区漏了中断提示/全屏按钮"这类只有一边修好的偏差。 */
function ProcBody(props: {
    node: BlockNode;
    onFull: (title: string, content: string) => void;
    live?: boolean;
}) {
    return (
        <Switch>
            <Match when={props.node.tag === "think"}>
                <ThinkBody node={props.node} />
            </Match>
            <Match when={props.node.tag === "tool"}>
                <ToolBody node={props.node} onFull={props.onFull} live={props.live} />
            </Match>
        </Switch>
    );
}

/**
 * 过程行：标题 + （可选）状态灯 + chevron；正文按 open 渲染；直播且展开时跟随到底。
 *
 * `showMark=false` 用于**汇总条铺开后的逐条行**（4 级）：那一行上面已有汇总计数、
 * 每行再顶一个 ✓/💭 是把同一件事说两遍（2026-10-11 用户口径；同一天汇总条自身的前缀
 * 图标串也已删）。⚠️ 注意它连 ●（在跑）/ ✗（报错）也一起不画 —— 4 级的失败块仍会
 * 由 `error` 着色标出，故可接受；若要恢复状态灯，改这里而不是加回汇总条的图标串。
 */
function ProcessRow(props: {
    node: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
    showMark?: boolean;
}) {
    const n = () => props.node;
    const open = () => procOpen(n(), props.pin);
    let bodyRef: HTMLDivElement | undefined;
    // 直播展开时跟随到底：订阅整树信号（每 op 重跑一次），仅当 open 且未定稿
    createEffect(() => {
        void localChatStore.trees;
        if (open() && !n().stopped && bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
    });
    return (
        <div
            class="rounded-lg border border-base-300 bg-base-200/40 text-body"
            data-block-id={n().id}
            data-block-tag={n().tag}
        >
            <DisclosureHead
                open={open()}
                onToggle={() => props.onToggle(n().id)}
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-base-200/60"
            >
                <Show when={props.showMark !== false}>{statusMark(n())}</Show>
                <span class="font-medium text-base-content/80 truncate flex-1">
                    {summaryOf(n(), open())}
                </span>
                <IconChevron open={open()} class="h-3.5 w-3.5 opacity-40" />
            </DisclosureHead>
            <Show when={open()}>
                <div ref={(el) => (bodyRef = el)} class="px-3 pb-2 max-h-72 overflow-auto">
                    <ProcBody node={n()} onFull={props.onFull} />
                </div>
            </Show>
        </div>
    );
}

/**
 * 轮次级展开（2026-10-11 定稿：**级别循环**，取代「正常 / 大纲」两态开关）。
 *
 * 一个 turn = 轮首用户发言 + 级别控制 + 内容区 + 轮尾实时区。级别**每轮各自一份**，
 * 像 JSON 树那样点一下展开一层、点完最深层回到最浅层（语义见 `lib/chat-fold.ts`）：
 *   1 全收缩   只有这一行（身份/统计）—— 连结论也收起，一屏扫完"我聊了哪些轮"
 *   2 结论     + 末条助理正文（压成 N 行摘要，带渐隐与"还有 N 行"提示行）
 *   3 全部正文 + 其余正文与过程汇总条（连续已定稿的 think/tool 收成一行计数）
 *   4 逐条过程 汇总条铺开成"每事件一行"
 * 而**工具/思考的内容（详情层）不在循环里**：那是用户自己点开的那一下（procOpen），
 * 级别按钮不管它 —— 否则"看某个工具的完整输出"要被级别状态牵着走。
 *
 * 恒显项（与级别无关）：轮首用户发言（"我说过啥"的脉络本体）、error 块（一轮报错后
 * 收起就与成功轮次长得一模一样 = 信息丢失，review P1-2）、轮尾用量条、直播中的实时区。
 *
 * 身份（🤖 头像 · 人物 · 模型 · 思考级别）是**该轮事实**的投影（`turn.attrs.model` /
 * `reasoningEffort`），不是当前配置 —— 否则改一次 personas.yaml 全部历史署名被一起改写
 * （任务 196 的教训）。**整个身份（含 🤖 头像）都只在 2 级起显示**：1 级要的是一屏扫完
 * "我聊了哪些轮"，再点一次"谁答的"只是噪音（2026-10-11 用户口径：1 级连头像也删）。
 *
 * 折叠体**不重排**：只做"藏中间过程"，用户发言/插话/error 一律就地渲染（见 chat-fold.ts）。
 */

/**
 * 轮次头（人物标题 bar）：身份 + 统计 + 开合箭头。点它 = **这一轮**收拢 / 展开。
 *
 * 身份（🤖 头像 · 人物 · 模型 · 思考级别）**任何级别都显示** —— 用户 2026-10-11 口径：
 * "1 级的人物 bar 和 2 级不一样，需要一致，也需要显示人物/模型信息"。
 * 身份是**该轮事实**的投影（`turn.attrs.model` / `reasoningEffort`），不是当前配置 ——
 * 否则改一次 personas.yaml，全部历史署名被一起改写（任务 196 的教训）。
 *
 * 统计只放"这轮发生了什么"：步数 · 耗时 · ⚙ n · 💭 n · ❌ n。
 *   · **不放 token**：轮尾那行（时刻 + 用量）已经写着，同一屏里同一件事说两遍
 *     （2026-10-11 用户口径）。
 *   · **不放 `n/4`**：级别循环归顶部那个按钮，单轮只有开/合两态，摆个分数像"还能再点几层"。
 */
function TurnHeader(props: {
    /** 轮次 id（节点按 id 现取：行对象按 id 复用，见文件头注） */
    turnId: string;
    level: TurnLevel;
    onToggle: () => void;
    counts: { step: number; tool: number; think: number; error: number };
}) {
    const t = () => turnById(props.turnId);
    // 身份是**该轮事实**的投影（turn.attrs.model），不是当前配置（任务 196 的教训）
    const id = () => taskStore.selectedTask?.persona ?? personaStore.idForTask();
    const persona = () => personaStore.defOfLive(id());
    const info = () =>
        bylineOf({
            turnModel: t().attrs.model,
            personaName: persona()?.name ?? null,
            personaModel: persona()?.model ?? null,
        });
    // 思考级别：**该轮事实**（main 在 turn start 写进 meta），不是当前配置
    const effort = () => str(t().attrs.reasoningEffort);
    // 耗时：该轮事实（main 在收尾 patch 写入 durationMs）
    const durMs = () => {
        const d = t().attrs.durationMs;
        return typeof d === "number" ? d : null;
    };
    const fmtDur = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms}ms`);
    const summary = () => {
        const c = props.counts;
        const parts: string[] = [];
        if (c.step) parts.push(`${c.step} 步`);
        const d = durMs();
        if (d != null) parts.push(fmtDur(d));
        if (c.tool) parts.push(`⚙ ${c.tool}`);
        if (c.think) parts.push(`💭 ${c.think}`);
        // 报错在**统计里**也要有位置：收拢时 error 块仍是唯一露头的内容，
        // 但一屏多轮时先看见"哪轮出过事"更快
        if (c.error) parts.push(`❌ ${c.error}`);
        return parts.join(" · ");
    };
    const open = () => props.level > TURN_LEVEL_MIN;
    return (
        <DisclosureHead
            open={open()}
            onToggle={props.onToggle}
            class="flex items-center gap-1.5 w-full text-left rounded-lg px-1.5 py-1 hover:bg-base-200/60 text-body"
            ariaLabel={`${info().name ?? "助理"}${info().model ? `（${personaStore.displayModel(info().model)}）` : ""}：${summary()}；${turnFoldTip(open())}`}
            rest={{
                "data-testid": "turn-header",
                "data-block-id": t().id,
                "data-block-tag": "turn",
                "data-level": String(props.level),
                "data-inferred": info().inferred ? "1" : undefined,
                title: `${turnFoldTip(open())}\n${info().title}`,
            }}
        >
            {/* 身份：**所有级别都显示**（1 级与 2 级必须一致，用户 2026-10-11 口径） */}
            <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15"
                aria-hidden="true"
            >
                🤖
            </span>
            <Show when={info().name}>
                <span class="font-medium">{info().name}</span>
            </Show>
            <Show when={info().model}>
                <span class="opacity-60">{personaStore.displayModel(info().model)}</span>
            </Show>
            {/* 思考级别：该轮实际生效的档位（main 写入 turn meta） */}
            <Show when={effort() && effort() !== "none"}>
                <span class="opacity-50">·</span>
                <span class="opacity-60">{reasoningEffortLabel(effort() as ReasoningEffort)}</span>
            </Show>
            <Show when={info().inferred}>
                <span class="opacity-40">（当时人物未知）</span>
            </Show>
            <span class="flex-1" />
            <span class="text-caption opacity-60">{summary()}</span>
            <IconChevron open={open()} class="h-3.5 w-3.5 opacity-40" />
        </DisclosureHead>
    );
}

/**
 * 实时区（直播轮次**轮尾**）：把"当前活动"那一步**展开**画出来。
 *
 * 为什么放轮尾而不是塞进文档序：它是"此刻正在发生的事"，不是历史流的一段；
 * 位置固定才不用在长会话里翻找（旧版是一行 delta 混在流里，一滚就没了）。
 *
 * 三处定死的行为（都是用户反馈换来的）：
 *   ① **高度固定**（`h-` 不是 `max-h-`，≈5 行）：早先是 max-height，内容一行行长出来时
 *      整块往下顶、屏幕来回跳；think 因为内容连续还好，tool 从"只有命令行"到
 *      "一大段输出"一跳就是十几行。固定高度后**任何时刻**这块的尺寸都一样 ——
 *      内容在框内自己滚（2026-10-11 反馈）。
 *   ② **状态切换不换布局**：跑完不消失、也不再多出一行"等待下一步"（那也会顶开一格），
 *      而是把状态写在标题行右侧（`进行中` ⇄ `⋯ 等待下一步`）。冻结的输出留在框里 ——
 *      用户要看的就是"刚刚那条命令输出了什么"（2026-10-11 反馈：工具输出没进活动框）。
 *   ③ **两种状态都画 `ProcBody`**（同一份渲染）：分成两处写就会出现"活动态修好了、
 *      等待态漏了"这类只有一边对的偏差。
 *
 * `liveArea.node` 必须已从文档序渲染里剔除（见 TurnView.segs）——否则同一块画两遍。
 */
function LiveAreaView(props: { area: LiveArea; onFull: (title: string, content: string) => void }) {
    const n = () => props.area.node;
    let bodyRef: HTMLDivElement | undefined;
    // 活动体在流：每帧贴到底（看最新输出，而不是从头看）。
    // 等待态**不**跟随：那时内容已冻结，用户若往上翻了就应该停在他看的位置。
    createEffect(() => {
        void localChatStore.trees;
        if (props.area.active && bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
    });
    return (
        <div
            class="mt-1 rounded-lg border border-primary/30 bg-base-200/40 px-2 py-1.5 text-body"
            data-live-area={props.area.active ? "active" : "waiting"}
            data-block-id={n().id}
            data-block-tag={n().tag}
        >
            <div class="flex items-center gap-2">
                {statusMark(n())}
                {/* 实时区恒是"展开"的（正文就在下面那个定高框里）：标题写档位，不预览首行 */}
                <span class="font-medium text-base-content/80 truncate flex-1">{summaryOf(n(), true)}</span>
                <span class="shrink-0 text-caption opacity-50" data-live-state>
                    <Show when={props.area.active} fallback={<span class="animate-pulse">⋯ 等待下一步…</span>}>
                        进行中
                    </Show>
                </span>
            </div>
            {/* 高度 ≈ 5 行正文（leading-relaxed 1.625em × 5 ≈ 8.2em）：固定值，超出在框内滚 */}
            <div
                ref={(el) => (bodyRef = el)}
                class="mt-1 h-[8.2em] overflow-auto rounded bg-base-100/50 px-2 py-1"
                data-live-body
            >
                <ProcBody node={n()} onFull={props.onFull} live />
            </div>
        </div>
    );
}

/** assistant 正文（展开态）：全文，md/原文由全局开关决定；每轮身份已在轮次头，不再单独署名 */
function TextBlock(props: { node: BlockNode; md: boolean }) {
    const b = () => props.node;
    return (
        <div data-block-id={b().id} data-block-tag="text">
            <Show when={props.md} fallback={<PlainText text={str(b().attrs.content)} />}>
                <MarkdownText text={str(b().attrs.content)} streaming={!b().stopped} />
            </Show>
        </div>
    );
}

/**
 * 1 级「摘要结论」：末条助理正文压成 N 行摘要，点提示行进 2 级看全文。
 *
 * 两个易错点（都是用户反馈过的）：
 *   ① **必须跟 MD 渲染/原文开关走**（2026-10-11 反馈：摘要态强制原文、展开态才是渲染，
 *      同一个块两种格式切换很怪）。摘要仍走同一份正文，只是行数少了 —— 渲染方式与
 *      是否截断是两个正交维度，不能互相决定。截断处 Markdown 会在围栏/列表中间断开，
 *      交给 MarkdownView 的 streaming 分支兜底（未闭合围栏照样成块），不退回原文。
 *   ② 「被裁剪过」必须**一眼可见**（2026-10-11 反馈：只截 3 行看不出被缩过）：
 *      底部**渐隐**暗示"下面还有"（Linear / Notion / Apple 摘要一路），
 *      再加**可点提示行**说清"还有几行 + 点哪看全"（GitHub / Slack 的 Show more 一路）。
 *      只靠 CSS line-clamp 自带的 `…` 信息量最低，且会把代码块截在结构中间。
 */
function ConclusionText(props: {
    node: BlockNode;
    /** 摘要行数上限（仅 1 级用） */
    lines: number;
    /** true = 压成摘要（1 级）；false = 全文（2 级起） */
    clamp: boolean;
    md: boolean;
    /** 点提示行 = 进下一级（全文在下一级） */
    onExpand: () => void;
}) {
    const b = () => props.node;
    const raw = () => str(b().attrs.content);
    // 直播中的结论不截：它还在长，截断只会来回跳；定稿后才压成摘要。
    // clamp=false（2 级）时**永不截** —— 那一级要的就是全文，级别说了算，组件不自作主张
    const clipped = () => props.clamp && b().stopped;
    const view = () => (clipped() ? clampLines(raw(), props.lines) : { text: raw(), omitted: 0 });
    const cut = () => view().omitted > 0;
    return (
        <div data-block-id={b().id} data-block-tag="text" data-clamped={cut() ? "1" : undefined}>
            <div
                style={
                    cut()
                        ? {
                              "mask-image":
                                  "linear-gradient(to bottom, #000 45%, rgba(0,0,0,0) 100%)",
                              "-webkit-mask-image":
                                  "linear-gradient(to bottom, #000 45%, rgba(0,0,0,0) 100%)",
                          }
                        : undefined
                }
            >
                <Show when={props.md} fallback={<PlainText text={view().text} />}>
                    <MarkdownText text={view().text} streaming={!b().stopped || cut()} />
                </Show>
            </div>
            <Show when={cut()}>
                {/* 提示行是独立 button：正文（上面那层 div）仍可拖选复制 */}
                <button
                    type="button"
                    class="mt-0.5 text-caption opacity-60 hover:opacity-100 hover:text-primary"
                    onClick={() => props.onExpand()}
                >
                    ⋯ 已折叠 {view().omitted} 行 · 点击展开全部正文
                </button>
            </Show>
        </div>
    );
}

/** 用户发言气泡（右对齐）：一切档位/模式下都全文 —— 它就是"我说过啥"的脉络本体 */
function UserBubble(props: { node: BlockNode }) {
    const b = () => props.node;
    const steer = () => str(b().attrs.steer);
    return (
        <div class="flex justify-end">
            <div class="max-w-[85%] bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-prose whitespace-pre-wrap break-words">
                <Show when={steer()}>
                    <span class="mb-0.5 block text-caption opacity-60">
                        ⤵ 插话（{steerModeLabel(steer())}）{steerModeTip(steer())}
                    </span>
                </Show>
                {str(b().attrs.content)}
            </div>
        </div>
    );
}

/**
 * 紧凑行（3 级起）：一行的「过程 + 收束它的那条正文」（见 `chat-fold.contentItems`）。
 *
 * 收起 = **一行**：正文首行 + 过程计数 + 箭头；展开 = 逐条正文 + 逐条过程单行
 * （展开的样子与 4 级那一行长一样 —— 用户 2026-10-11 口径："展开就还是第 4 层"）。
 * 所以 `open` 不跟级别走死：**用户的 pin 优先，否则跟 4 级**。整体切到 4 级 = 全部行都展开，
 * 单点某一行 = 只展开这一行，两者共用同一套渲染，不会各说各话。
 *
 * 展开后标题**不再复述正文首行**（那条正文就写在下面，同一屏里看两遍 —— 同 think 行的口径）。
 */
function CompactRow(props: {
    row: { key: string; text: BlockNode | null; parts: BlockNode[] };
    open: boolean;
    /** 点整行 = 切这一行的 pin（**不是**换级别：级别循环归顶部按钮） */
    onToggle: () => void;
    pin: Record<string, boolean>;
    onToggleProc: (id: string) => void;
    onFull: (title: string, content: string) => void;
    md: boolean;
}) {
    const thinks = () => props.row.parts.filter((n) => n.tag === "think").length;
    const tools = () => props.row.parts.filter((n) => n.tag === "tool").length;
    const failed = () => props.row.parts.some((n) => n.tag === "tool" && str(n.attrs.status) === "error");
    /** 收起时的标题：这条正文的首行；本行还没有正文（过程刚跑出来）时退到最后一个过程的摘要 */
    const title = () => {
        if (props.open) return "";
        const tx = props.row.text;
        if (tx) return firstLine(str(tx.attrs.content)).trim() || "（空正文）";
        const last = props.row.parts[props.row.parts.length - 1];
        return last ? summaryOf(last, false) : "";
    };
    return (
        <div class="rounded-lg" data-block-tag="compact-row" data-block-id={props.row.key}>
            <DisclosureHead
                open={props.open}
                onToggle={props.onToggle}
                class="flex items-center gap-2 w-full py-1 px-1.5 rounded-lg hover:bg-base-200/60 text-body"
                /* 读屏文案：thinks() 为 0 时不能落成模板串里的 `0 && …`（求值成 0，念作「02 个工具」） */
                ariaLabel={`过程：${thinks() ? `${thinks()} 段思考、` : ""}${tools()} 个工具${props.row.text ? `；正文：${firstLine(str(props.row.text.attrs.content)).slice(0, 30)}` : ""}（点击${props.open ? "收起" : "展开"}这一行）`}
            >
                <span class="min-w-0 flex-1 truncate text-base-content/80">{title()}</span>
                <Show when={failed()}>
                    <span class="shrink-0 text-error" title="这一行里有失败的工具">
                        ✗
                    </span>
                </Show>
                <span class="shrink-0 text-caption opacity-50">
                    {thinks() ? `💭 ${thinks()}` : ""}
                    {thinks() && tools() ? " · " : ""}
                    {tools() ? `⚙ ${tools()}` : ""}
                </span>
                <IconChevron open={props.open} class="h-3.5 w-3.5 opacity-40" />
            </DisclosureHead>
            <Show when={props.open}>
                <div class="mt-0.5 ml-2 space-y-0.5 border-l border-base-300 pl-2">
                    <For each={props.row.parts}>
                        {(n) => (
                            <PartRow
                                node={n}
                                pin={props.pin}
                                onToggle={props.onToggleProc}
                                onFull={props.onFull}
                            />
                        )}
                    </For>
                    <Show when={props.row.text}>
                        {/* 正文收束本行：文档序上它就在这些过程之后（见 contentItems） */}
                        {(tx) => <TextBlock node={tx()} md={props.md} />}
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/**
 * 紧凑行铺开后的**逐条**：过程 → 单行（各自再点开才是内容 = 第 5 层）；plan / 未知块照实画。
 *
 * `showMark={false}`：这一行的形状已由外层紧凑行的计数说过（上面那排 `💭 n ⚙ n`），
 * 每行再顶一个 ✓/💭 是把同一件事说两遍（2026-10-11 用户口径）。
 */
function PartRow(props: {
    node: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const b = props.node;
    if (b.tag === "think" || b.tag === "tool") {
        return (
            <ProcessRow
                node={b}
                pin={props.pin}
                onToggle={props.onToggle}
                onFull={props.onFull}
                showMark={false}
            />
        );
    }
    if (b.tag === "plan") {
        return (
            <div class="text-body opacity-70">
                📋 计划：
                <For each={(b.attrs.items as unknown[]) ?? []}>
                    {(it) => <div>• {str(it)}</div>}
                </For>
            </div>
        );
    }
    return <div class="text-body opacity-40">[未知块 {b.tag}]</div>;
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
        <div
            class="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-body text-error whitespace-pre-wrap"
            data-block-id={props.node.id}
            data-block-tag="error"
        >
            {`❌ [${str(props.node.attrs.source)}] ${str(props.node.attrs.message)}`}
        </div>
    );
}

/** 轮次内各类事件计数（轮次头的统计用）。error 也数：一屏多轮时先看见"哪轮出过事" */
function countTags(turn: BlockNode): { step: number; tool: number; think: number; error: number } {
    let step = 0,
        tool = 0,
        think = 0,
        error = 0;
    const walk = (x: BlockNode) => {
        for (const c of x.children) {
            if (c.tag === "step") step++;
            else if (c.tag === "tool") tool++;
            else if (c.tag === "think") think++;
            else if (c.tag === "error") error++;
            walk(c);
        }
    };
    walk(turn);
    return { step, tool, think, error };
}

function TurnView(props: {
    /** 轮次 id（节点按 id 现取 —— 行对象按 id 复用，见文件头注） */
    turnId: string;
    /** 过程**详情**层的开合（用户自己点出来的那一下；与级别无关） */
    pin: Record<string, boolean>;
    /** 本轮展开级别（1-4，见 lib/chat-fold 的 TurnLevel） */
    level: TurnLevel;
    /** 点轮次头 = **收拢 / 展开这一轮**（不换层；层归顶部那个全局按钮） */
    onCycle: () => void;
    /** 1 级结论摘要的行数 */
    conclusionLines: number;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
    liveTurnId: string | null;
    md: boolean;
    /** 用量 hover 卡（页面级状态：块树重建不丢） */
    usageHover: UsageHoverState | null;
    onHoverUsage: (id: string, el: HTMLElement) => void;
    onHoverEndUsage: () => void;
    /** 用量明细抽屉（打开的 turnId；页面级，单实例覆盖式） */
    usageDetail: string | null;
    onDetailUsage: (id: string) => void;
}) {
    const t = () => turnById(props.turnId);
    const plan = () => planOfLevel(props.level);
    /** 轮首用户发言：渲染在轮次头**之前**（IM 顺序）。见 chat-fold.leadUsers */
    const lead = () => leadUsers(t());
    /**
     * 1-2 级的内容区（严格文档序，只"藏中间过程"、不"搬位置"）：
     *   · 1 级：轮中插话 + error + 末条正文（**压 N 行摘要**）
     *   · 2 级：同上，但末条正文给**全文**（其余正文仍不显示）
     * 为什么必须文档序：插话块在文档序上位于轮次**中间**，旧版把"全部用户发言"提到最前，
     * 它就被拽到了自己那条助理回复的下面 —— 看着像"助理先说、用户后说"（2026-10-04 现象）。
     * 轮首那批已由 lead 渲染，这里用 foldBody 剔掉，避免画两遍。
     */
    const foldBody = () => {
        const head = lead();
        const items = foldedItems(t());
        return head.length ? items.filter((n) => !head.includes(n)) : items;
    };
    const isLiveTurn = () => props.liveTurnId != null && props.liveTurnId === t().id;
    // 上帧的行序列：跨次渲染复用未变的行（`<For>` 按引用 diff —— 不复用就是每帧重建 = 点击全丢）
    let prevItems: ContentItem[] = [];
    /** 轮尾实时区（仅直播轮次）。它的节点必须**从文档序渲染里剔除** —— 否则同一块
     *  画两遍（旧版：展开态过程行一处、轮尾 delta 行一处，同一句出现两次，review P1-1）。 */
    const liveArea = () => liveAreaOf(t(), isLiveTurn());
    const items = () => {
        const live = liveArea()?.node;
        prevItems = reuseItems(prevItems, contentItems(t(), (n) => n === live));
        return prevItems;
    };
    const counts = () => countTags(t());
    /** 紧凑行的开合：用户的 pin 优先，否则跟 4 级。键加 `row:` 前缀 —— 行键 = 该行首个叶子 id，
     *  不加前缀会与那个叶子自己的过程 pin 撞车（点过程变成连整行一起开合）。 */
    const rowOpen = (key: string) => {
        const p = props.pin[`row:${key}`];
        return p === undefined ? plan().midExpanded : p;
    };
    return (
        <div class="space-y-1.5" data-turn-id={t().id} data-turn-level={props.level}>
            {/* 轮首用户发言**先出**：IM 直觉是"用户先说、对方再接"。
                轮次头（助理身份行）压在用户消息上面 = 看着像助理先开口（2026-10-11 反馈）。 */}
            <For each={lead()}>{(n) => <UserBubble node={n} />}</For>
            <TurnHeader
                turnId={props.turnId}
                level={props.level}
                onToggle={props.onCycle}
                counts={counts()}
            />
            <Show
                when={plan().mid}
                fallback={
                    <div class="space-y-1.5 pl-1">
                        <For each={foldBody()}>
                            {(n) =>
                                isUserText(n) ? (
                                    <UserBubble node={n} />
                                ) : n.tag === "error" ? (
                                    /* error 在**所有级别**都露头：一轮报错后收起来与成功轮次
                                       长得一模一样，最后一条正文还可能是报错前的旧内容 */
                                    <ErrorBox node={n} />
                                ) : (
                                    <ConclusionText
                                        node={n}
                                        lines={props.conclusionLines}
                                        clamp={plan().conclusionClamped}
                                        md={props.md}
                                        onExpand={props.onCycle}
                                    />
                                )
                            }
                        </For>
                    </div>
                }
            >
                {/* 3 级起：中间区 = 紧凑行（过程 + 收束它的正文合成一行）+ 结论全文
                    + 用户发言 + error，全部按文档序（见 chat-fold.contentItems） */}
                <div class="space-y-1 pl-1">
                    <For each={items()}>
                        {(it) => {
                            if (it.kind === "user") return <UserBubble node={it.node} />;
                            if (it.kind === "error") return <ErrorBox node={it.node} />;
                            if (it.kind === "conclusion") return <TextBlock node={it.node} md={props.md} />;
                            return (
                                <CompactRow
                                    row={it}
                                    open={rowOpen(it.key)}
                                    onToggle={() => props.onToggle(`row:${it.key}`)}
                                    pin={props.pin}
                                    onToggleProc={props.onToggle}
                                    onFull={props.onFull}
                                    md={props.md}
                                />
                            );
                        }}
                    </For>
                </div>
            </Show>
            {/* 轮尾实时区：直播轮次的"当前活动"（固定高度；跑完不消失）。
                与级别无关 —— 它就是"此刻在干什么"。 */}
            <Show when={liveArea()}>
                {(la) => <LiveAreaView area={la()} onFull={props.onFull} />}
            </Show>
            {/* 截断/步数耗尽提示：main 按生效 limits 写入，限制值动态非硬编码 */}
            <Show when={str(t().attrs.notice)}>
                <div class="text-body text-warning">⚠ {str(t().attrs.notice)}</div>
            </Show>
            {/* 轮尾：**时刻靠左、纯文本、不可点**（滚屏阅读时左侧最容易误触，那句话也没有可点的东西），
                用量按钮靠右（hover 出汇总卡、点击开明细抽屉）—— 两个状态都存页面级：
                块树每帧重建，组件内 signal 会被清掉（D3 的"点开又自动合上"）。 */}
            <Show when={t().attrs.usage}>
                <TurnUsageBar
                    turnId={t().id}
                    usage={t().attrs.usage}
                    hover={props.usageHover?.id === t().id}
                    onHover={(el) => props.onHoverUsage(t().id, el)}
                    onHoverEnd={props.onHoverEndUsage}
                    onDetail={() => props.onDetailUsage(t().id)}
                />
            </Show>
            <Show when={t().attrs.interrupted && !isLiveTurn()}>
                <div class="text-body text-warning">⚠ 本轮未完成（流中断/崩溃恢复）</div>
            </Show>
            {/* 等待助理首个事件：仅本轮生成中且尚无助理内容时显示 */}
            <Show when={isLiveTurn() && !hasAssistantContent(t())}>
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
                    class="shrink-0 border-t bg-base-200/60 px-3 py-1.5 text-body"
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
                            <div class="flex items-center gap-2 rounded border bg-base-100 px-2 py-1 text-body shadow-lg opacity-90 select-none pointer-events-none">
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
                class="shrink-0 cursor-grab text-base-content/40 hover:text-base-content/80 active:cursor-grabbing"
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
                class={`btn btn-xs shrink-0 swap ${ it().mode === "next-step" ? "border-warning/60 bg-warning/15 text-warning hover:bg-warning/25" : "btn-ghost text-base-content/45 hover:text-base-content/80" }`}

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
                    <span class="font-mono text-body truncate flex-1">{props.title}</span>
                    <button class="btn btn-ghost btn-xs" onClick={copy}>
                        复制
                    </button>
                    <button class="btn btn-ghost btn-xs" onClick={() => props.onClose()}>
                        ✕
                    </button>
                </div>
                <pre class="overflow-auto p-4 text-body font-mono whitespace-pre-wrap break-all flex-1">
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
                <div class="px-4 py-3 border-b font-bold text-title">{props.title}</div>
                <div class="px-4 py-3 text-body opacity-80">{props.message}</div>
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
    /** 「⋯」溢出菜单：低频/危险操作（清空历史）默认不显示，点开才露出（VSCode 附加菜单式） */
    const [moreOpen, setMoreOpen] = createSignal(false);
    /** 压缩历史（事件快照列表）；压缩参数改在「窗口构成页」第一 tab（M1），卡内可快捷直压 */
    const [gensOpen, setGensOpen] = createSignal(false);
    const [personaPanelOpen, setPersonaPanelOpen] = createSignal(false);
    const [fullscreen, setFullscreen] = createSignal(false);
    let scrollRef: HTMLDivElement | undefined;
    /** 跟随态：true=贴底（新内容自动滚到底）；false=用户正在上方阅读（绝不打扰） */
    const [stick, setStick] = createSignal(true);
    /** 恢复中闸门：历史重放期间 trees 连发，须让位给 restore 的定位（否则被抢先滚到底） */
    let restoring = false;
    /** 当前会话的运行态轮询停止函数（切会话/卸载时调用） */
    let unwatch: (() => void) | null = null;

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
            if (!target.closest("[data-more-control]")) setMoreOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setMoreOpen(false);
                setPersonaPanelOpen(false);
                setFullscreen(false);
                setUsageBoard(false);
                cancelHoverClose();
                setUsageHover(null);
                setUsageDetail(null);
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
    // + 停掉运行态轮询（没人看就不该继续问 main）
    onCleanup(() => {
        unwatch?.();
        unwatch = null;
        const u = uri();
        if (u) void draftStore.flushNow(u);
    });
    // 直播中的尾轮 turn id：中断警告 / 等待态 gating 用。
    // 判据是 main 真值（localChatStore.live），不是本地 running —— 别人（CLI/另一窗口）
    // 正在跑的轮次同样是"直播中"，否则那一轮的未收 stop 会被显示成"流中断/崩溃恢复"。
    const liveTurnId = () => {
        if (!localChatStore.live) return null;
        const turns = localChatStore.trees.filter((t) => t.tag === "turn");
        return turns.length ? turns[turns.length - 1]!.id : null;
    };
    // Markdown 渲染开关（视图 cache 持久化）：全局开关而非 per-message
    const [md, setMdRaw] = createSignal<boolean>(Caches.diy_chat_md.get());
    const setMd = (v: boolean) => {
        setMdRaw(v);
        Caches.diy_chat_md.set(v);
    };
    /**
     * 展开级别 = **全局一份 + 每轮的"收拢"标记**（2026-10-11 用户口径，第三次修正）。
     *
     *   ① 顶部 `n/4 展开` —— **唯一**的换层入口：所有轮次一起换层（读长会话时整段调粗细），
     *      按一下把手动收拢的轮次也一并复位（"对所有轮次切换"就该是全量；
     *      留着收拢标记会让点过的那些轮次纹丝不动，看着像按钮失灵）。
     *   ② 点某一轮的人物标题 bar —— **只收拢 / 展开这一轮**，不换层。
     *      上一版让它按 1→2→3→4 循环，用户否掉：单条信息不该有"点第几下到第几层"，
     *      点一下就是"合上/打开"（语义见 `levelOfTurn`）。
     *
     * 落盘策略：全局级别**落盘**（"我习惯看多细"是长期偏好，重开 app 不该变），
     * 单轮的收拢标记**不落盘**（轮次 id 会无限增长，逐轮写进 localStorage 只会越攒越脏）。
     */
    const levelFromCache = (): TurnLevel => {
        const v = Caches.diy_chat_level.get();
        return isTurnLevel(v) ? v : DEFAULT_TURN_LEVEL;
    };
    const [globalLevel, setGlobalLevelRaw] = createSignal<TurnLevel>(levelFromCache());
    const setGlobalLevel = (l: TurnLevel) => {
        setGlobalLevelRaw(l);
        Caches.diy_chat_level.set(l);
    };
    /** 单轮的"收拢 / 展开"标记（三态：true 收拢 / false 展开 / undefined 没动过跟全局）。
     *  不落盘 —— 轮次 id 会无限增长，逐轮写进 localStorage 只会越攒越脏。 */
    const [foldMarks, setFoldMarks] = createSignal<Record<string, boolean>>({});
    /** 这一轮用哪一级（语义见 levelOfTurn：没动过就完全跟全局） */
    const levelOf = (turnId: string): TurnLevel => levelOfTurn(foldMarks()[turnId], globalLevel());
    /** 人物标题 bar：**收拢 / 展开这一轮**（不换层）——按"现在是什么态"决定翻到哪一边 */
    const toggleTurn = (turnId: string) =>
        setFoldMarks((p) => ({ ...p, [turnId]: levelOf(turnId) > TURN_LEVEL_MIN }));
    /** 全部轮次换层（顶部按钮）：连同收拢标记一起复位 */
    const cycleAllLevels = () => {
        setGlobalLevel(cycleTurnLevel(globalLevel()));
        setFoldMarks({});
    };
    /** 1 级摘要的行数 */
    const conclusionLines = () => Caches.diy_chat_conclusion_lines.get();
    /** 清空确认：清空会删掉 main 侧 ops/llm 日志（rmSync，不可恢复），必须二次确认 */
    const [confirmClear, setConfirmClear] = createSignal(false);
    const [pinned, setPinned] = createSignal<Record<string, boolean>>({});
    const togglePin = (id: string) => setPinned((p) => ({ ...p, [id]: !p[id] }));
    // 用量两级交互状态（hover 卡 + 明细抽屉）：与 pinned 同构，**存页面级组件外** ——
    // 块树每帧重建，组件局部 signal 会随之复位（D3 的"点开又被自动合上"就是这么来的）。
    const [usageHover, setUsageHover] = createSignal<UsageHoverState | null>(null);
    const [usageDetail, setUsageDetail] = createSignal<string | null>(null);
    /** hover 进入：记下触发元素与坐标（卡片 Portal 定位用）；离开走延迟关闭（160ms 跨间隙） */
    const hoverUsageIn = (id: string, el: HTMLElement) => {
        cancelHoverClose();
        const r = el.getBoundingClientRect();
        setUsageHover({
            id,
            anchor: el,
            left: Math.round(r.left),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            above: r.top > 280, // 上方放不下 → 卡翻到下方
        });
    };
    const hoverUsageOut = () => armHoverClose(() => setUsageHover(null));
    const [full, setFull] = createSignal<{ title: string; content: string } | null>(null);
    /**
     * 根行清单：**按 id 复用行对象**（块树每帧给新节点，行对象不能跟着换）。
     *
     * 为什么不能直接 `<For each={localChatStore.trees}>`：`<For>` 按**引用**判定同一行，
     * 而直播那一轮的节点每帧都是新对象 ⇒ 整轮 DOM（含轮次头）每帧重建。后果不是"卡"，
     * 是**点击全丢** —— 浏览器不给"按下与松开落在不同元素上"的手势派发 click
     * （2026-10-11 CDP 实测：直播中点任何展开 bar 都无反应，全页连一个 click 事件都没有）。
     * 行对象按 id 复用后，只有真正变了的那一行才重建，DOM 留在原地。
     */
    let prevRows: { key: string; tag: string }[] = [];
    const rootRows = createMemo(() => {
        const byKey = new Map(prevRows.map((r) => [r.key, r]));
        prevRows = localChatStore.trees.map((t) => {
            const old = byKey.get(t.id);
            return old && old.tag === t.tag ? old : { key: t.id, tag: t.tag };
        });
        return prevRows;
    });
    /** 会话用量看板（抽屉）开关 */
    const [usageBoard, setUsageBoard] = createSignal(false);

    createEffect(
        on(uri, (u, prev) => {
            // 切走前保存旧会话阅读位置（组件不卸载，滚动容器 DOM 还在）+ 冲掉待写草稿
            if (prev) {
                if (scrollRef) localChatStore.setScroll(prev, scrollRef.scrollTop);
                void draftStore.flushNow(prev);
            }
            // 切走：停掉上一个会话的运行态轮询（只轮询当前打开的会话）
            unwatch?.();
            unwatch = null;
            // 进入新会话：内容恢复（历史重放）+ 阅读位置恢复 + 输入框草稿恢复
            // + 运行态真值轮询（别人在跑 → 界面必须知道，见 store.watch）
            if (u) {
                restore(u);
                applyDraft(u);
                unwatch = localChatStore.watch(u);
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
        // live（含别人正在跑）= main 会拒发（"正在生成中"），本地先拦：不发无效请求
        if (!text || !uri() || localChatStore.live) return;
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
        if (localChatStore.view.busy) void submitSteer(DEFAULT_STEER_MODE); // 真值：别人的轮次在跑同样留言（回车分流同按钮）
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
            {/* 打开时顺手对一次账本（轮次间隙别人跑的那几轮不该漏） */}
            <UsageDrawer open={usageBoard()} uri={uri()} onClose={() => setUsageBoard(false)} />
            {/* L3：本轮逐步明细抽屉（覆盖式；turnId 页面级，单实例） */}
            <TurnUsageDetailDrawer
                turnId={usageDetail()}
                live={liveTurnId() === usageDetail()}
                onClose={() => setUsageDetail(null)}
            />
            {/* L2：用量汇总 hover 卡（Portal 到 body，滚动容器裁不到） */}
            <UsageHoverCard
                state={usageHover()}
                onEnter={cancelHoverClose}
                onLeave={hoverUsageOut}
                onDetail={(id) => {
                    cancelHoverClose();
                    setUsageHover(null);
                    if (id === "session") setUsageBoard(true);
                    else setUsageDetail(id);
                }}
            />
            {/* 顶部：对话 view 的**视图级控制**（Markdown 显示方式 + 信息密度 + 清空本会话历史）。
                pr-16：ViewGrid 的 area 设施（最大化/最小化）浮在本区域**右上角**，
                不预留这条空档，按钮会与它叠在同一坐标上（实测重叠）。 */}
            <div
                class={`flex items-center justify-end gap-2 pl-4 pr-16 ${VIEW_BAR_H} border-b shrink-0`}
            >
                {/* 全局展开级别：`n/4 展开` 点一下**所有轮次**换一层（2026-10-11 用户口径：
                    **只有它能换层**）。整段调粗细是高频动作，20 轮逐轮点太累；单轮那边只有
                    "收拢 / 展开"两态（点人物标题 bar，收拢标记见 foldedTurns）。
                    **第 5 层（单条过程内容）不进这个循环** —— 一轮几十个事件、每个几百行，
                    一屏放不下两轮，那份内容只由用户点那一行自己开。 */}
                <button
                    class="btn btn-xs shrink-0 gap-1"
                    data-testid="chat-level-all"
                    data-level-all={String(globalLevel())}
                    data-tip={turnLevelTip(globalLevel())}
                    aria-label={turnLevelTip(globalLevel())}
                    onClick={cycleAllLevels}
                >
                    <span class="text-body leading-none">{`${globalLevel()}/${TURN_LEVEL_MAX} 展开`}</span>
                    <IconChevron open={globalLevel() > TURN_LEVEL_MIN} class="h-3.5 w-3.5 opacity-40" />
                </button>
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
                {/* 「⋯」溢出菜单：低频/危险操作的收容处（学 VSCode 视图栏的 ... 附加菜单）。
                    清空历史破坏且不可恢复，常驻图标太显眼（防误删已改三轮：改名/确认/挪位，
                    本轮诉求是**位置/层级**）—— 收进来，点开才露出。
                    生成中整个菜单不显示：正跑着的会话不该在此时被清掉（沿用原行为）。
                    二次确认仍保留（ConfirmDialog 在下方），菜单只解决「太显眼」。 */}
                <Show when={!localChatStore.live}>
                    <div class="relative shrink-0" data-more-control>
                        <button
                            class="btn btn-ghost btn-xs"
                            data-tip="更多操作（低频 / 危险动作）"
                            aria-label="更多操作"
                            aria-expanded={moreOpen()}
                            onClick={(e) => {
                                e.stopPropagation();
                                setMoreOpen((v) => !v);
                            }}
                        >
                            <span class="text-body leading-none">⋯</span>
                        </button>
                        <Show when={moreOpen()}>
                            <div
                                class="absolute right-0 top-full z-20 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-1 shadow-xl"
                                data-more-control
                                onClick={(e) => e.stopPropagation()}
                            >
                                <button
                                    class="btn btn-ghost btn-xs w-full justify-start gap-2 normal-case font-normal"
                                    aria-label="压缩历史"
                                    onClick={() => {
                                        setMoreOpen(false);
                                        setGensOpen(true);
                                    }}
                                >
                                    压缩历史…
                                </button>
                                <button
                                    class="btn btn-ghost btn-xs w-full justify-start gap-2 normal-case font-normal"
                                    aria-label="清空本对话历史"
                                    onClick={() => {
                                        setMoreOpen(false);
                                        setConfirmClear(true);
                                    }}
                                >
                                    <IconTrash class="h-4 w-4 text-error" />
                                    清空本对话历史
                                </button>
                            </div>
                        </Show>
                    </div>
                </Show>
            </div>

            {/* 块树滚动区 */}
            <div
                ref={(el) => (scrollRef = el)}
                class="flex-1 overflow-y-auto px-4 py-3"
                onScroll={(e) => setStick(nearBottom(e.currentTarget))}
            >
                <div class="space-y-3">
                    <For each={rootRows()}>
                        {(row) =>
                            row.tag === "turn" ? (
                                <TurnView
                                    turnId={row.key}
                                    pin={pinned()}
                                    level={levelOf(row.key)}
                                    onCycle={() => toggleTurn(row.key)}
                                    conclusionLines={conclusionLines()}
                                    onToggle={togglePin}
                                    onFull={(title, content) => setFull({ title, content })}
                                    liveTurnId={liveTurnId()}
                                    md={md()}
                                    usageHover={usageHover()}
                                    onHoverUsage={(id, el) => hoverUsageIn(id, el)}
                                    onHoverEndUsage={hoverUsageOut}
                                    usageDetail={usageDetail()}
                                    onDetailUsage={(id) => setUsageDetail((d) => (d === id ? null : id))}
                                />
                            ) : row.tag === "error" ? (
                                /* 遗留的**根级** error 块（历史日志：旧版上限提示未挂 parent）。
                                   新日志已把提示挂进 turn（见 local-agent 的上限分支），但重放旧
                                   ops.jsonl 时根块仍会出现 —— 必须能读懂，不能只吐「[未知根 error]」。
                                   这类块一旦落盘就不再变，故按值取一次即可（不必走 getter） */
                                <ErrorBox node={turnById(row.key)} />
                            ) : (
                                <div class="text-body opacity-40">[未知根 {row.tag}]</div>
                            )
                        }
                    </For>
                    <Show when={localChatStore.error}>
                        <div class="text-error text-body">{localChatStore.error}</div>
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
                        class="btn btn-ghost btn-xs swap swap-rotate absolute right-1 top-1 z-10"
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
                    <div class="flex shrink-0 items-center gap-2 px-2 py-2 text-body">
                        {/* 人物入口：打开人物面板（选/改/换绑都在那里）。
                            按钮本身显示**本任务当前用谁 + 它的模型与档位** ——
                            "我这条消息会发给哪个模型"必须一眼可见，不用点开才知道。 */}
                        <button
                            class="btn btn-ghost btn-xs max-w-[280px] min-w-0"
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
                                        ? `${personaStore.displayModel(personaDef()!.model)} · ${reasoningEffortLabel(personaDef()!.reasoningEffort as ReasoningEffort)}`
                                        : "加载中…"}
                                    ）
                                </span>
                            </span>
                            <span class="opacity-50">⚙</span>
                        </button>
                        {/* L1② 会话累计 chip（紧贴人物右侧的空白区）：hover 出 L2 汇总卡，
                            卡上「明细」开 L3 看板。页面级状态，与 turn 底 bar 同构。 */}
                        <SessionUsageChip
                            hover={usageHover()?.id === "session"}
                            onHover={(el) => hoverUsageIn("session", el)}
                            onHoverEnd={hoverUsageOut}
                            onDetail={() => setUsageBoard(true)}
                        />
                        {/* L1 窗口占用环（chip 的 token/金额总量右侧）：hover 出构成卡（含「压缩」按钮 + 可降低窗口比较条）。
                            【用户 2026-10-07】压缩入口**移进 token 窗口的 card**（不再单独一个按钮）；生成中禁用+提示。 */}
                        <WindowRing />
                        <div class="flex-1" />
                        {/* 生成中的可见性：别人（CLI/另一窗口）发起时本地 running 全程为 false，
                            不显式说出来，界面看起来就像"什么都没发生"（任务 194 现象一的另一半） */}
                        <Show when={localChatStore.view.busy && !localChatStore.sending}>
                            <span class="text-body text-primary" aria-label="其他端正在生成">
                                其他端（CLI/窗口）正在生成…
                            </span>
                        </Show>
                        {/* 留言（steer 插话）：只在**输入框有内容**时出现 —— 没打字就没得留。
                            判据用真值 busy：别人的轮次在跑同样能排队留言。 */}
                        <Show when={localChatStore.view.busy}>
                            <Show when={inputValue().trim()}>
                                <button
                                    class="btn btn-outline btn-xs"
                                    data-tip="留言：排到下一轮（回车同此）。想让它马上生效，提交后点上方那条的闪电图标"
                                    onClick={() => void submitSteer(DEFAULT_STEER_MODE)}
                                >
                                    留言
                                </button>
                            </Show>
                        </Show>
                        {/* 三态：停止中（已请求停止、main 收尾）→ 生成中（可停止）→ 发送。
                            停止按钮**不分谁发起的**：main 报告活跃就给入口（含 CLI 那轮）；
                            外观沿用 steer 分支的 aura 装饰。 */}
                        <Switch>
                            <Match when={localChatStore.view.stopping}>
                                {/* 收尾期间**不许**退回"生成中"：那样输入框会解锁、发送按钮出现，
                                    而服务端仍会拒发（它眼里还在生成）—— 界面与服务端结论相反。
                                    卡住（超过宽限期 main 仍报活跃）时不装死，给一个更强的出口：
                                    再点一次 = 重发中断（main 侧 abort 幂等，可安全重复）。 */}
                                <span class="text-body opacity-60">
                                    {localChatStore.view.stoppingStuck ? "已停止，仍在收尾（可强制中断）…" : "已停止，后台收尾中…"}
                                </span>
                                <div class="aura text-error rounded-full" style={{ "--aura-padding": "2px", "--tw-duration": "2.4s" }}>
                                    <button
                                        class="btn btn-error btn-sm"
                                        data-tip={
                                            localChatStore.view.stoppingStuck
                                                ? "收尾超时；再点一次强制中断（可重复，main 侧幂等）"
                                                : "正在收尾…"
                                        }
                                        disabled={!localChatStore.view.stoppingStuck}
                                        onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                    >
                                        {localChatStore.view.stoppingStuck ? "强制中断" : "停止中…"}
                                    </button>
                                </div>
                            </Match>
                            <Match when={localChatStore.view.busy}>
                                <div class="aura text-error rounded-full" style={{ "--aura-padding": "2px", "--tw-duration": "2.4s" }}>
                                    <button
                                        class="btn btn-error btn-sm"
                                        data-tip="中断本轮生成（保留已产出内容；由其他端发起的轮次同样可停）"
                                        onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                    >
                                        停止
                                    </button>
                                </div>
                            </Match>
                            <Match when={!localChatStore.live}>
                                <button
                                    class="btn btn-primary btn-sm"
                                    data-tip="发送（回车发送 / Shift+回车换行）"
                                    onClick={() => void submit()}
                                >
                                    发送
                                </button>
                            </Match>
                        </Switch>
                    </div>
                </div>
            </div>

            <Show when={gensOpen() && uri()}>
                <CompactHistoryPanel uri={uri()!} onClose={() => setGensOpen(false)} />
            </Show>
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

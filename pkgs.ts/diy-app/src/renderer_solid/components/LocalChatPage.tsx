/**
 * LocalChatPage — 本地自定义 agent 对话页（ai-sdk 块协议，独立于 ACP ChatPage）
 *
 * 一轮 = **过程历史 + 结尾槽 + 状态行**（用户 2026-10-12 R22 口径，草图 rail-v4.html）：
 *   · **过程历史**（`chat-fold.turnRows`，一个 `<For>`）：这轮做过的事（正文 / 工具 / 思考）。
 *     **可折叠** —— 人物栏 chevron 手动开合（`historyOpenOf`）；全局 1-4 级只改"展开多少"。
 *   · **结尾槽**（`tailOf`）：这轮的落点。**自暴露、恒显、不受历史折叠影响、与状态行同级**
 *     —— 四形态：结论 / 结束点 / 现场 / 执行过程。
 *   · **状态行**（`TurnUsageBar`）：末行恒显，上虚线 + 纯文本（不卡片化）。
 *
 * 级别（`lib/chat-fold` 的 TurnLevel）：1 摘要结论 → 2 完整结论 → 3 全部正文 → 4 逐条过程。
 *   **循环只归顶部那个 `n/4 展开` 按钮**（对所有轮次一起换层，且**复位**所有手工痕迹）；
 *   点某一轮的人物标题 bar 只是"把我这一条的历史收拢 / 展开"两态，见 `historyOpenOf`。
 *   **第 5 层（单条工具/思考的内容）不在级别里**：太庞大，只由用户点那一行自己开。
 *
 * ⚠️ 历史行**按 key 复用行对象**（见 `rootRows` / `reuseRows`）：`<For>` 按引用判定同一行，
 *   而直播轮的块树节点每帧都是新对象 —— 直接喂新数组会让整块 DOM 每帧重建，后果不是"卡"
 *   而是**点击全丢**（2026-10-11 CDP 实测）。
 * ⚠️ 结尾槽那一条叶子由 `turnRows` **排除在历史行之外**（判据一处：`tailOf`）——
 *   两处判据一分叉就是同一块画两遍（review P1-1）。
 *
 * 「开/关」一律由 `RowGutter` 表达（**行首那一列折叠条**：整块高的一根条 + 首行居中的尖头，
 * 见其头注）。**不塞在内容行内** —— 手柄是结构不是内容，要成列、要压在皮肤那条结构物上
 * （色条 / 贯穿线），2026-10-12 用户口径「竖版折叠条」。
 * 可展开行头一律 `DisclosureHead`（div + role=button：**按钮内的文本选不中**，见其头注）。
 * 「显示什么、按什么序、开到第几层」的语义全在 `lib/chat-fold.ts`（纯函数 + 单测），本文件只管画。
 * MD 渲染/原文是**正交**的显示偏好：摘要态同样按它渲染（见 TextRow）。
 */
import {
    createContext,
    createEffect,
    createMemo,
    createSignal,
    For,
    Match,
    on,
    onCleanup,
    onMount,
    Show,
    Switch,
    untrack,
    useContext,
} from "solid-js";
import type { JSX } from "solid-js";
import { loadFullBlockFields, localChatStore } from "../store/localChatStore";
import { personaStore } from "../store/personaStore";
import { PersonaDrawer } from "./PersonaDrawer";
import {
    TurnUsageBar,
    TurnUsageDetailDrawer,
    SessionUsageChip,
    WindowRing,
    OverallRateChip,
    sessionAvgRate,
    UsageDrawer,
    UsageHoverCard,
    armHoverClose,
    cancelHoverClose,
    type UsageHoverState,
} from "./UsagePanel";
import { CompactHistoryPanel } from "./CompactSessionPanel";
import { TrafficDrawer } from "./TrafficDrawer";
import {
    ConfirmDialog,
    IconBolt,
    IconChevron,
    IconClock,
    IconCode,
    IconCompress,
    IconExpand,
    IconGrip,
    IconTrash,
    RowGutter,
} from "@diy/ui-kit";
import { InputLimitDialog } from "./InputLimitDialog";
import type { InputGate } from "../../shared/context/input-limit";
import { OpsDownBar } from "./OpsDownBar";
import { copyFailMeta, copyOkMeta } from "../lib/notice-copy";
import { chatNotice, DETAIL_CHAT_FIND, DETAIL_HISTORY } from "../lib/notice-chat";
import { draftStore } from "../store/draftStore";
import { trafficStore } from "../store/trafficStore";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { NoticeDetail } from "./NoticeDetail";
import {
    isTerminalSessionState,
    TERMINAL_STATE_REASON,
    terminalSessionDetail,
} from "../../shared/turn-gate";
import { Caches, CONCLUSION_LINES_MAX, CONCLUSION_LINES_MIN } from "../lib/ui-state";
import { HeightLedger, stackRows, windowRange } from "../lib/chat-virtual";
import { chatFindStore, type ChatFindHit } from "../store/chatFindStore";
import { jobRunsStore } from "../store/jobRunsStore";
import { chatNavStore, type ChatNavTarget } from "../store/chatNavStore";
import { detachablesStore } from "../store/detachablesStore";
import type { JobNavTarget } from "../../shared/run-view";
import { findStore } from "../store/findStore";
import { ChatFindPanel } from "./ChatFindPanel";
import { clearHitHighlight, paintHitHighlight } from "../lib/hit-highlight";
import { MarkdownView } from "./MarkdownView";
import { MdEditor } from "./MdEditor";
import { memberCompletion, taskCompletion } from "../lib/completions";
import { bubbleAlignClass, hasAuthor, roomOriginOf } from "../lib/user-bubble";
import { bylineOf } from "../lib/assistant-byline";
import {
    deliveryBadge,
    deliveryStateText,
    MAIN_MEMBER_ID,
    memberAvatar,
    memberColor,
    memberName,
    opsOwnsEvent,
    orderedMembers,
    shortName,
    steerTurnRefs,
    type Room,
    type RoomEvent,
} from "../../shared/room";
import { fmtClock } from "../../shared/date-format";
import { diyService } from "../lib/rpc";
import { layoutStore } from "../store/layoutStore";
// 滚动决策（纯函数，可单测：跟随时序 / 锚点恢复）—— 本文件只负责 DOM 读写
import { anchorScrollTop, anchorTick, clampScrollTop, followPlan, lastLeafId, nearBottom as libNearBottom, type AnchorTickState, type ChatAnchor } from "../lib/chat-scroll";
// user 发言的时刻 label（纯函数：块 id → 所属轮起点时刻；数据源与降级口径见模块头注）
import { userStamp } from "../lib/user-stamp";
// 对话流的时间戳：真源是 turnId 内嵌的毫秒（shared/date-format 统一解析与格式化）
import type { ReasoningEffort } from "../../main/services/local-agent";
// 插话队列项：与草稿同文件存储（任务目录 .diy/drafts.yaml），类型只在 main 侧定义
import type { SteerItem } from "../../main/core/drafts";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import { VIEW_BAR_H, chatInputMaxHeight } from "../lib/layout-metrics";
// 文本取行（窗口化，##93）：摘要 / 预览 / 折叠都只吃需要的那一小段，且不每帧 split 全文
import { clampLines, countLines, firstLine, previewLines } from "../lib/chat-text";
import type { BlockNode } from "../../main/services/local-blocks";
import { INTERRUPTED_TOOL_NOTICE } from "../../main/services/local-blocks";
// 折叠 / 展开级别语义（纯函数，可单测）：显示什么、按什么序、开到第几层 —— 本文件只消费结果
import {
    DEFAULT_TURN_LEVEL,
    TURN_LEVEL_MAX,
    collapsedRows,
    composeTail,
    cycleTurnLevel,
    degradedOf,
    endLeafTip,
    endReasonOf,
    expandableOf,
    fmtBytes,
    fmtMs,
    intentOf,
    isFailedTool,
    isInterruptedToolBlock,
    isReceiptTurn,
    isTurnLevel,
    historyOpenOf,
    isUserText,
    leadUsers,
    leavesOf,
    linesFromDrag,
    liveTurnOf,
    liveTailOf,
    planOfLevel,
    procOpenOf,
    receiptStateOf,
    procStatusOf,
    spentOf,
    tailOf,
    turnEndNote,
    turnFoldTip,
    turnLevelTip,
    turnRows,
    waitTextOf,
    type ProcTone,
    type TurnLevel,
    type TurnRow,
    type TurnTail,
} from "../lib/chat-fold";
// 历史 mode 值归一与文案放 shared（纯函数、可单测）：ops 日志是 append-only 的史书，
// 枚举改名前的 step/turn 与现值长期共存，读侧必须归一（详见 shared/steer-mode.ts）
import { steerModeLabel, steerModeTip } from "../../shared/steer-mode";
// 降级历史（##424 刀 2）：文案在 shared（main / renderer 同一份），这里只拼
import { DEGRADED_DANGLING_TEXT, degradedBannerText } from "../../shared/degraded-history";

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

// 文本摘要 / 预览 / 折叠的取行逻辑在 `lib/chat-text.ts`（窗口化，##93）：本文件只消费结果。
/** 过程历史里正文行的折叠阈值（草图 v4 的 `.txt.clamp` 同款：超过 3 行才给折叠能力）。
 *  缺省**展开** —— 折叠是用户主动点的结果，级别不该替他把历史里的正文缩起来。 */
const HISTORY_TEXT_FOLD_LINES = 3;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

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
/** 距顶多少 px 内就算「滚到顶了」⇒ 触发补一段更早的历史（任务 293）。
 *  不取 0：滚动是像素级的，留一点余量才能在真的触顶前就把请求发出去（滚动手感更连续）。 */
const TOP_TRIGGER_PX = 240;
// `STICK_PX` / `nearBottom` 已抽到 `lib/chat-scroll`（##377 第 19 刀：room 侧事件流
// 也要同一套跟随判据，两处各写一份必然漂移）。
const nearBottom = (el: HTMLElement) => libNearBottom(el);

/** 块树里有没有这个 id（DFS；虚拟化下"块 → 行"的定位用，见 `anchorRowIndex`） */
function containsBlockId(n: BlockNode, id: string): boolean {
    if (n.id === id) return true;
    for (const c of n.children) if (containsBlockId(c, id)) return true;
    return false;
}

/** 按块 id 找 DOM（滚动容器内的块）—— 找不到 = 该块还没上屏（布局未稳 / 已被移除）。
 *  `CSS.escape`：块 id 形如 `t1791126774555_s1_a`，虽然当前都是安全字符，也照规矩转义。 */
function blockElOf(el: HTMLElement, id: string): HTMLElement | null {
    return el.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
}

/** 块在**内容坐标系**里的顶（px）：屏幕坐标差 + 当前 scrollTop —— 与滚动位置无关的量 */
function blockTopIn(el: HTMLElement, node: HTMLElement): number {
    return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/**
 * 视口顶部那一块 + 它在容器内的相对偏移（≤0 = 块顶被滚出容器顶）—— **阅读位置的锚点**（##331 ③）。
 *
 * 为什么锚 `[data-block-id]` 而不是 `[data-turn-id]`：一轮里可能有很多块，
 * 轮粒度太粗（长轮里切走切回想回到"同一段正文"，不是"同一轮"）。
 */
function pickAnchorIn(el: HTMLElement): ChatAnchor | null {
    const cTop = el.getBoundingClientRect().top;
    for (const n of el.querySelectorAll<HTMLElement>("[data-block-id]")) {
        const r = n.getBoundingClientRect();
        if (r.bottom > cTop + 1) {
            const id = n.getAttribute("data-block-id");
            return id ? { id, offset: Math.round(r.top - cTop) } : null;
        }
    }
    return null;
}

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
 * **会话渲染的数据源**（##166 §28.7 A 的落点）。
 *
 * 为什么要有它：块渲染器（`TurnView` 及其子树）原本直接读 `localChatStore` —— 那个 store
 * 是**单当前会话**的（`currentUri` + 一份 trees），于是同一页里**只能画一个会话**。
 * room 要的恰恰是**多个成员的进度并列**（一条发言投给 2 个 agent = 2 条进度同屏），
 * 所以把"从哪取树 / 是否直播"提成一个可注入的作用域：
 *   · 任务对话页 = 缺省（`localChatStore`），行为一字不变；
 *   · room 的进度展开 = 注入那一轮自己的树（`ChatView` 包一层）。
 * 渲染器**只有一份**（口径硬要求：不许为 room 另写一套），差别全在这层数据源。
 */
export interface ChatViewSource {
    /** 该作用域下的轮次树（升序） */
    trees: () => BlockNode[];
    /** 该作用域下是否正有轮次在跑（决定"直播中"形态：活动块 / 等待响应 / 中断标记） */
    live: () => boolean;
}

const ChatViewCtx = createContext<ChatViewSource>({
    trees: () => localChatStore.trees,
    live: () => localChatStore.live,
});

/** 给一段子树换数据源（room 的进度展开用它；任务对话页不包 = 走缺省） */
export function ChatView(props: { source: ChatViewSource; children: JSX.Element }) {
    return <ChatViewCtx.Provider value={props.source}>{props.children}</ChatViewCtx.Provider>;
}

/** 当前渲染作用域的"是否直播"（缺省即任务对话页那份真值） */
function viewLive(): boolean {
    return useContext(ChatViewCtx).live();
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
    return useContext(ChatViewCtx).trees().find((t) => t.id === id) ?? EMPTY_TURN;
}

// ─── 树工具（文档序） ───────────────────────────────

/** 空叶子：按 id 取不到时的兜底（行正在被移除），不让渲染期炸掉 */
const EMPTY_LEAF: BlockNode = { tag: "text", id: "", stopped: true, touched: 0, attrs: {}, children: [] };

/**
 * 按 id 取本轮某个叶子。**活动块只能这样取**：它每帧都是新对象（内容在流），
 * 而中间区的行对象要按引用稳定（见文件头注与 rootRows），所以行走"传 id + 现取"，
 * 不能把节点当值传下去（那是传一份会过期的快照）。
 */
function leafById(turnId: string, blockId: string): BlockNode {
    return leavesOf(turnById(turnId)).find((n) => n.id === blockId) ?? EMPTY_LEAF;
}

/** 本轮是否已出现助理侧内容（think/tool/text-assistant/error/plan）。
 *  发送后到首个助理事件之间有一段真空期（握手 + 上游首 token 往返），
 *  此时界面上只有 user 气泡，需要 loading 图标填充"正在处理"的反馈；
 *  一旦助理内容出现即让位给真实消息（含流式思考过程）。 */
function hasAssistantContent(turn: BlockNode): boolean {
    return leavesOf(turn).some((n) => !isUserText(n));
}
/**
 * 行的**身份复用**：`turnRows` 每帧都返回一组新对象，直接喂 `<For>` 就是每帧把整轮重建
 * —— 后果见文件头注（点击全丢）。行对象按 key + 内容（同引用）复用，DOM 才留在原地。
 *
 * 用**引用相等**做判据的依据与 `toTree` 的缓存一致：未变的块在块树里就是同一个对象，
 * 于是"内容没变" ⟺ "节点逐个同引用"。
 * （**结尾槽**不在本序列里 —— 它由 `tailOf` 单独画，直播时那个节点每帧换引用，
 *  反而正好：每帧重画才是"看着它长"要的效果。）
 */
function sameRow(a: TurnRow, b: TurnRow): boolean {
    if (a.kind !== b.kind || a.key !== b.key) return false;
    if (a.kind === "proc") {
        return (
            b.kind === "proc" &&
            a.parts.length === b.parts.length &&
            a.parts.every((n, i) => n === b.parts[i])
        );
    }
    return (b as { node: BlockNode }).node === a.node;
}

/**
 * 按位复用同形行（新数组，但元素尽量沿用旧对象 —— 元素的引用相等正是 `<For>` 的 diff 依据）。
 * 尾行**只带 id**（不带节点）：内容每帧都在变，带节点就是每帧换引用 = 每帧重建 DOM，
 * 后果不是"卡"而是**点击全丢**（见文件头注）。节点由 `leafById` 现取。
 */
function reuseRows(prev: TurnRow[], next: TurnRow[]): TurnRow[] {
    return next.map((s, i) => {
        const p = prev[i];
        return p && sameRow(p, s) ? p : s;
    });
}

// ─── 行摘要与正文 ───────────────────────────────────

function toolCommand(n: BlockNode): string {
    const args = n.attrs.args as { command?: string; path?: string } | undefined;
    if (args?.command) return args.command;
    if (args?.path) return `read ${args.path}`;
    return str(n.attrs.title);
}

/**
 * **流式中的命令草稿**（`tool-input-delta` 阶段的 `attrs.input`）。
 *
 * `args` 要等 `tool-call` 才到（`main/services/local-agent.ts` 的 `tool-call` 分支，
 * 与 `status="running"` 同一个 patch）—— 于是「模型正在生成参数」那几秒（实测 p50 125–372 ms、
 * p95 905 ms）框里连命令都没有，用户只看到一片白。可 `attrs.input` 里**已经是**逐片拼起来的
 * JSON 文本了（op `delta` → `fields.input`），命令就在里面，只是还是半截字符串。
 *
 * 这里只做一件事：把这半截的 `"command"` 值尽量完整地取出来（容忍未闭合、容忍转义断在中间）。
 * 取不出就返回空 —— 宁可空着，也不猜。
 */
function partialCommand(n: BlockNode): string {
    const raw = str(n.attrs.input);
    if (!raw) return "";
    const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
    if (!m) return "";
    const frag = m[1]!;
    // 完整且合法 ⇒ 直接解；被截断（转义断在末尾）⇒ 手工还原常见转义
    try {
        return JSON.parse(`"${frag}"`);
    } catch {
        return frag
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
            .replace(/\\$/, "");
    }
}

/** 框里该显示的完整命令：已定稿的优先，其次流式草稿（见 `partialCommand`） */
function shownCommand(n: BlockNode): string {
    return toolCommand(n) || partialCommand(n);
}

/**
 * 过程行的标题。`open` 参与：**思考行收起时预览首行**（一眼看出在琢磨什么），
 * 展开后只写"思考" —— 否则标题那句与下方正文的第一行是同一句，同一屏里看两遍
 *（2026-10-11 用户口径：展开后只显示"思考"）。
 *
 * `turn` 只给工具行用（算"意图"，见 `chat-fold.intentOf`）；不传就退回老口径（没有上下文时
 * 宁可不编造理由，也不把别处的思考贴上来）。
 */
function summaryOf(n: BlockNode, open = true, turn?: BlockNode): string {
    if (n.tag === "text") {
        // 正文也是"收取中的数据"（2026-10-11）：收起预览首行、展开只写"输出中/正文"
        // —— 与 think 同款，避免标题那句与体里第一行同屏看两遍
        if (open) return n.stopped ? "正文" : "输出中…";
        return firstLine(str(n.attrs.content)).trim() || "正文";
    }
    if (n.tag === "error") {
        // 错误块的单行说法（1-2 级的直播状态行 / 现场框标题用）
        return `[${str(n.attrs.source)}] ${firstLine(str(n.attrs.message))}`;
    }
    if (n.tag === "think") {
        // 首行**恒给**（2026-10-11 用户口径）：3 级 bar 的预览与 4 级逐条行要**同一句** ——
        // 工具行写 `tool · 命令首行`，思考行只写"思考"是不对称的。
        // 内容还空着（刚起）时才退回状态词。展开体是全文，首行会重复一次，那是"预览"的代价；
        // 单行思考干脆**不给展开能力**（见 expandableOf），从根上不重复。
        return firstLine(str(n.attrs.content)).trim() || (n.stopped ? "思考" : "思考中…");
    }
    if (n.tag === "tool") {
        // 标题 = `<tool> · <意图>`（##399 用户 2026-10-20 拍板 B）：意图 = 同一步里前一条 think 的
        // **末行**（模型自述"为什么动这一步"）。为什么不是命令首行：工具块在 `tool-input-start`
        // 就建了，那时 `args` 还是空的 —— 命令首行在 streaming 阶段根本不存在，标题只剩 `bash ·`
        // 空尾巴（实测占 P95 905ms 的窗口）。命令不丢：框体首行恒给 `$ <完整命令>`（见 ToolBody）。
        // 前面没有 think ⇒ 只写工具名（用户口径：「就只输出 'bash' 即可」）。
        const intent = turn ? intentOf(turn, n) : null;
        return `${str(n.attrs.tool) || "tool"}${intent ? ` · ${intent}` : ""}${isInterruptedToolBlock(n, viewLive()) ? " · ⊘ 中断" : ""}`;
    }
    return n.tag;
}

/**
 * think / tool 的**开销角标**（##399 用户 2026-10-20：「思考和工具的最右侧补上输出时间消耗和字节数，
 * 这是模型质量的观测」）。
 *
 * 两半各自独立可有：`ms` 是 main 后加的块字段（旧日志没有 ⇒ 不显示，**不用渲染时刻顶替**），
 * 字节数是客户端按正文/输出算的派生量（见 `chat-fold.spentOf`）。
 */
function SpentBadge(props: { node: BlockNode }) {
    const sp = () => spentOf(props.node);
    const text = () => {
        const v = sp();
        if (!v) return "";
        const parts: string[] = [];
        if (v.ms !== undefined) parts.push(fmtMs(v.ms));
        if (v.bytes > 0) parts.push(fmtBytes(v.bytes));
        return parts.join(" · ");
    };
    const tip = () =>
        `${props.node.tag === "think" ? "思考生成耗时" : "工具执行耗时"} / ${props.node.tag === "think" ? "思考" : "输出"}体积（UTF-8）`;
    return (
        <Show when={text()}>
            <span class="shrink-0 tabular-nums text-caption opacity-40" data-spent title={tip()}>
                {text()}
            </span>
        </Show>
    );
}

/**
 * 「看参数」开关：**按块 id 存**，因为按钮在**折叠行（bar）**上、JSON 在**框体**里，
 * 两处是两个组件实例 —— 状态放组件内就只有一边能看到另一边点了。
 * 用模块级 signal 而不是 props 逐层传：展开与否是**读屏偏好**，与轮次/折叠树无关。
 */
const [paramsOpen, setParamsOpen] = createSignal<Record<string, boolean>>({});
/**
 * 转后台的一句结果（按 toolCallId 存）。
 *
 * 为什么不放在 `DetachToggle` 自己的 signal 里：转成功后 main 那边条目就删了，
 * **按钮下一次刷新即消失**，组件随之卸载 —— 结果会跟着一起没，人只看到"按了一下，啥也没说"。
 */
const [detachNote, setDetachNote] = createSignal<Record<string, string>>({});

function toggleParams(id: string) {
    setParamsOpen({ ...paramsOpen(), [id]: !paramsOpen()[id] });
}

/** 这块有没有参数可看（流式早期的 `input` 也算 —— 半截 JSON 也比空着强） */
function hasParams(n: BlockNode): boolean {
    if (n.tag !== "tool") return false;
    return n.attrs.args !== undefined || !!str(n.attrs.input);
}

/**
 * **bar 上的 `<>`**（##408 用户 2026-10-23 订正）：
 * 「应该在 bash 输出的 **bar** 上加 `<>` 图标，你加到了内容区域」。
 * 所以它挂在折叠行（`ProcessRow` / `TailBox` 的 `data-row-head`）里，与状态灯、耗时角标同级；
 * 框体里只负责把 JSON 画出来。
 */
function ParamsToggle(props: { node: BlockNode; onOpen?: () => void }) {
    const n = () => props.node;
    const open = () => !!paramsOpen()[n().id];
    return (
        <Show when={hasParams(n())}>
            <button
                class="btn btn-ghost btn-xs min-h-0 shrink-0 px-1 text-caption opacity-40 hover:opacity-100"
                classList={{ "opacity-100 text-primary": open() }}
                data-tool-params-toggle="1"
                data-tip="看这次工具调用的参数：模型发的原文 + 工具实际收到的（含缺省值）"
                aria-label="查看工具参数"
                onClick={(e) => {
                    // 折叠行自己也吃点击 —— 不拦就会「点参数 = 展开/收起正文」
                    e.stopPropagation();
                    // 体是折叠的就没有 `ToolBody` 可挂面板（点了只会"什么都没发生"，实测踩过）：
                    // 先要参数就必须先把行打开。
                    props.onOpen?.();
                    toggleParams(n().id);
                }}
            >
                {"<>"}
            </button>
        </Show>
    );
}

/**
 * bar 上的「转后台」（##408 刀 21，对应 opencode 的 `ctrl+b`）。
 *
 * 为什么挂在**折叠行**而不是框体里：与 `<>` 同一条理由（用户 2026-10-23 订正）——
 * bar 是"这个块此刻的状态位"那一行，动作属于状态，不属于正文。
 *
 * **只画 main 说能转的**（`job.detachables`）：还在跑、拿得到 toolCallId、属于本任务。
 * 三项缺一就不画 —— 一个按下去必然失败的按钮，比没有按钮更糟（用户会以为功能坏了）。
 * 转完按钮自己消失（main 那边条目已删，下一次刷新就没了），并留一句结果在原地。
 */
function DetachToggle(props: { node: BlockNode }) {
    const n = () => props.node;
    const [busy, setBusy] = createSignal(false);
    return (
        <Show when={n().tag === "tool" && detachablesStore.has(n().id)}>
            <button
                class="btn btn-ghost btn-xs min-h-0 shrink-0 px-1 text-caption opacity-60 hover:opacity-100"
                data-tool-detach="1"
                data-tip="转后台：进程不动、前半段输出不丢，工具调用立刻返回 run id；结束时会插话叫醒 agent"
                aria-label="转后台运行"
                disabled={busy()}
                onClick={async (e) => {
                    // 折叠行自己也吃点击 —— 不拦就会「点转后台 = 展开/收起正文」
                    e.stopPropagation();
                    setBusy(true);
                    const msg = await detachablesStore.detach(n().id);
                    setDetachNote({ ...detachNote(), [n().id]: msg });
                    setBusy(false);
                }}
            >
                {busy() ? "⏳" : "⇥ 转后台"}
            </button>
        </Show>
    );
}

/** 转后台的结果留在原地几秒（按钮消失后，人得知道"刚才那一下成了没有"） */
function DetachNote(props: { node: BlockNode }) {
    return (
        <Show when={props.node.tag === "tool" ? detachNote()[props.node.id] : undefined}>
            {(t) => <span class="shrink-0 text-caption text-base-content/60">{t()}</span>}
        </Show>
    );
}

/** 状态灯档位 → class（**只有这里认 class**；"什么时候失败"的判据在 `procStatusOf`） */
const STATUS_TONE_CLASS: Record<ProcTone, string> = {
    error: "text-error",
    ok: "text-success",
    warn: "text-warning",
    wait: "text-warning",
    muted: "opacity-50",
    none: "",
};

/** 行首状态灯：判据在 `lib/chat-fold.procStatusOf`（纯函数 + 单测），这里只画（见其头注） */
function statusMark(node: BlockNode) {
    const m = procStatusOf(node, viewLive());
    if (!m.icon) return null;
    const cls = [STATUS_TONE_CLASS[m.tone], m.pulse ? "animate-pulse" : ""].filter(Boolean).join(" ");
    return (
        <span class={cls || undefined} title={m.tip}>
            {m.icon}
        </span>
    );
}

/**
 * 「已载入全文」的块（##93 D 的按需读）：**至多存一个** —— 用户点开哪块就只留哪块，
 * 否则这个缓存本身又成了新的无上限内存（正是本任务要治的病）。
 */
const [fullBlock, setFullBlock] = createSignal<{ id: string; fields: Record<string, string> } | null>(null);

/** 该块某字段的全文（没点过「载入全文」时 undefined ⇒ 调用方退回硬顶后的显示值） */
function fullTextOf(id: string, field: string): string | undefined {
    const f = fullBlock();
    return f && f.id === id ? f.fields[field] : undefined;
}

/** 千分位（与 main 侧 `fmtNum` 同一取向：不用 `toLocaleString`，免得随环境飘） */
function fmtCount(n: number): string {
    const t = String(Math.trunc(n));
    let out = "";
    for (let i = 0; i < t.length; i++) {
        if (i > 0 && (t.length - i) % 3 === 0) out += ",";
        out += t[i];
    }
    return out;
}

/**
 * 被 Text 硬顶裁过的块：**明说**「现在看到的是头尾两段」+ 给一个「载入全文」出口。
 *
 * 为什么要这一条：裁剪本身是静默的（值里只有一行 `<cut by="renderer-text-cap" scope="view" …/>`），
 * 若不给出口，用户会以为那块的中间内容**丢了**；而按需读（重折一份无硬顶的段）要用户
 * 明确点一下才付代价（4 MB 段重折 ≈ 180 ms，瞬时 ~3 MB）。见任务 body「按需读走 ②」。
 */
function CapNotice(props: { node: BlockNode; field: "content" | "output" }) {
    const cap = () => (props.node.attrs.__cap as Record<string, { total: number; omitted: number }> | undefined)?.[props.field];
    const [busy, setBusy] = createSignal(false);
    const load = async () => {
        if (busy()) return;
        setBusy(true);
        try {
            const fields = await loadFullBlockFields(props.node.id);
            if (fields) setFullBlock({ id: props.node.id, fields });
            else
                notificationStore.addToast(
                    "info",
                    "这块的完整内容已不在会话日志里",
                    chatNotice(
                        "载入全文 · loadFullBlockFields（##93 D）",
                        `该块 ${props.node.id} 所在的段从盘上重取回来重折后已不含这个 id（日志被改写 / 块已被新帧替换）→ 不拿裁过的值冒充全文`,
                        DETAIL_HISTORY,
                    ),
                );
        } finally {
            setBusy(false);
        }
    };
    return (
        <Show when={cap()}>
            <div class="flex flex-wrap items-center gap-2 py-1 font-sans text-xs text-base-content/60" data-cap-notice>
                <span>
                    界面只保留了头尾两段（共 {fmtCount(cap()!.total)} 字符，已省略 {fmtCount(cap()!.omitted)}）
                </span>
                <button class="btn btn-ghost btn-xs min-h-0 px-1" disabled={busy()} onClick={load}>
                    {busy() ? "载入中…" : "载入全文"}
                </button>
            </div>
        </Show>
    );
}

function ThinkBody(props: { node: BlockNode }) {
    const text = () => fullTextOf(props.node.id, "content") ?? str(props.node.attrs.content);
    return (
        <div class="whitespace-pre-wrap leading-relaxed">
            {text()}
            <CapNotice node={props.node} field="content" />
        </div>
    );
}

function ToolBody(props: {
    node: BlockNode;
    onFull: (title: string, content: string) => void;
    /** true = 画在轮尾活动框里（活的那个工具）：命令行恒给出、内层不再自己滚 */
    live?: boolean;
}) {
    // ⚠ 必须是**访问器**：`props.node` 是连到 store 的 getter，`const n = props.node`
    // 会在组件创建时把它拍平成一个引用 —— 里面的 `Show when={…}` 是 memo，读到的是普通
    // 对象字段（非信号），**只算一次永不再算** ⇒ 直播中的工具框创建时空、之后一直空。
    // 这是「工具执行中一片空白」的根因（##399 实测）；思考框没这问题，因为它把
    // `props.node.attrs.content` 直接写在 JSX 表达式里（那是 effect，每帧重读）。
    const n = () => props.node;
    const output = () => fullTextOf(props.node.id, "output") ?? str(n().attrs.output);
    /** 全文行数：**按块版本 memo** —— 块没变就不重算；只有正在流式增长的这块每帧付一次
     *  `countLines`（3.28 M ≈ 1.5 ms，零分配），定稿后只算一次。见 ##93（不为提示数字每帧 split 全文）。 */
    const totalLines = createMemo(() => countLines(output()));
    /** 预览本身也 memo：一帧里它被读两次（`data-tip` + 正文），不必每次重切首尾行 */
    const pv = createMemo(() => previewLines(output(), 20, 30, totalLines()));
    const title = () => `${str(n().attrs.tool)} · ${toolCommand(n())}`;
    // 命令行**恒给**（##399 用户 2026-10-20）：折叠行的标题已改成 `<tool> · <意图>`
    // （拍板 B），标题里**不再有命令** ⇒ "折叠行已显示命令首行，展开体别重复"这个前提失效了。
    // 命令是"这一步到底跑了什么"的唯一事实源，必须留在体里；无命令（streaming 早期 / 中断）才省。
    const cmd = () => shownCommand(n());
    const cmdNeedsFull = () => !!cmd();
    /**
     * **两段式参数**（用户 2026-10-23 二轮订正）：
     * ① **模型发的原文** —— `args`（流式早期退回逐片拼的 `input`，半截 JSON 也比空着强）；
     * ② **工具实际收到的** —— `execArgs`（main 侧 `shared/tool-args.ts` 补完缺省的那一份，
     *    被补上的键记在 `execDefaults` 里并逐个标注）。
     *
     * 只给①会让人以为 `background` / `timeout` 不存在（用户实测就是这么误判的）；只给②则
     * 看不出模型自己说了什么。两份并列，谁也不用猜。
     */
    const rawParamsText = (): string => {
        const args = n().attrs.args;
        if (args && typeof args === "object") return JSON.stringify(args, null, 2);
        return str(n().attrs.input) || "（还没有参数）";
    };
    const execParamsText = (): string => {
        const eff = n().attrs.execArgs;
        if (!eff || typeof eff !== "object") return "";
        const def = new Set(
            Array.isArray(n().attrs.execDefaults) ? (n().attrs.execDefaults as unknown[]).map((k) => String(k)) : [],
        );
        const json = JSON.stringify(eff, null, 2);
        if (def.size === 0) return json;
        // 逐行标注「这行是补的」：JSON 里看不出"显式 false"和"没传补 false"的区别，
        // 而这恰恰是用户要判断的那件事 —— 只能在这里标。
        return json
            .split("\n")
            .map((line) => {
                const m = /^\s*"([^"]+)":/.exec(line);
                return m && def.has(m[1]!) ? `${line}   // 缺省值（模型没发）` : line;
            })
            .join("\n");
    };
    return (
        <div class="space-y-1 font-mono" data-tool-body>
            <Show when={cmdNeedsFull()}>
                <pre class="text-base-content/70">$ {cmd()}</pre>
            </Show>
            <Show when={paramsOpen()[n().id]}>
                <div class="space-y-1 rounded bg-base-100/60 p-2" data-tool-params>
                    <div class="text-caption opacity-60">模型发的参数（原文）</div>
                    <pre class="max-h-60 overflow-auto whitespace-pre-wrap text-base-content/80">{rawParamsText()}</pre>
                    <Show when={execParamsText()}>
                        <div class="text-caption opacity-60">工具实际收到的参数（补完缺省）</div>
                        <pre class="max-h-60 overflow-auto whitespace-pre-wrap text-base-content/80">
                            {execParamsText()}
                        </pre>
                    </Show>
                </div>
            </Show>
            <Show when={output()}>
                {/* 相对定位容器：**最大化按钮**浮在框右上角（≠ 插一行按钮把正文挤下去，
                    也不随内层滚动跑）。点了开全屏（`FullscreenModal`，那里给「恢复」）。
                    恒显（不只超长时）：短输出也可能要整屏看/复制，判据不该是"有没有被截过"。 */}
                <div class="relative">
                    <button
                        class="btn btn-ghost btn-xs absolute right-1 top-1 z-10 min-h-0 px-1 opacity-40 hover:opacity-100"
                        data-tool-max="1"
                        data-tip={`最大化（全屏查看 / 复制，共 ${pv().exact ? "" : "≥"}${pv().total} 行）`}
                        aria-label="最大化工具输出"
                        onClick={() => props.onFull(title(), output())}
                    >
                        <IconExpand class="h-3.5 w-3.5" />
                    </button>
                    {/* live：内层不设 max-h/overflow —— 外面那层就是唯一的滚动容器，
                        两层各自滚动会出现"滚不动"的错觉（实测：内层吃掉滚轮）。
                        `pr-8` 给右上角那个按钮让位，长行不钻到它下面。 */}
                    <pre
                        class={`whitespace-pre-wrap bg-base-100/60 rounded p-2 pr-8 ${props.live ? "" : "max-h-72 overflow-auto"}`}
                    >
                        {pv().text}
                    </pre>
                </div>
            </Show>
            {/* **状态与输出分离**（##399 用户 2026-10-20 二轮）：框体是**输出区**，只放命令与结果；
                "此刻在等什么"一律只说在标题栏那一格（`TailBox` 的 `data-live-state`），
                这里**不再复述**（同一句话一处看两遍 = 用户说的"把状态和输出混在一起"）。
                结果还没到就空着；连命令都还没有（参数还在流）时留一个终端提示符当锚，
                避免定高框一片白（有命令后不再给，否则 `$ cmd` 与占位 `$` 上下各一行 = 重复）。 */}
            <Show when={props.live && !output() && !cmd() && !isInterruptedToolBlock(n(), viewLive())}>
                <pre class="text-base-content/25" data-live-idle>
                    $
                </pre>
            </Show>
            <CapNotice node={n()} field="output" />
            {/* 中断遗留：正文显示与发往 LLM 完全同源的占位说明（不再是空白让人无从下手） */}
            <Show when={isInterruptedToolBlock(n(), viewLive())}>
                <div class="alert alert-warning alert-soft text-body py-2 font-sans">
                    <span class="whitespace-pre-wrap">{INTERRUPTED_TOOL_NOTICE}</span>
                </div>
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
    /** 正文的渲染方式（md / 原文）—— 与页面上其它正文同一开关，不另开一套 */
    md?: boolean;
}) {
    /** 正文（MD 渲染 / 原文两条路共用）：点过「载入全文」就用全文，否则用硬顶后的显示值 */
    const bodyText = () => fullTextOf(props.node.id, "content") ?? str(props.node.attrs.content);
    return (
        <Switch>
            <Match when={props.node.tag === "think"}>
                <ThinkBody node={props.node} />
            </Match>
            <Match when={props.node.tag === "tool"}>
                <ToolBody node={props.node} onFull={props.onFull} live={props.live} />
            </Match>
            <Match when={props.node.tag === "text"}>
                <Show when={props.md} fallback={<PlainText text={bodyText()} />}>
                    <MarkdownText text={bodyText()} streaming={!props.node.stopped} />
                </Show>
                <CapNotice node={props.node} field="content" />
            </Match>
            <Match when={props.node.tag === "error"}>
                <div class="whitespace-pre-wrap text-error">{str(props.node.attrs.message)}</div>
            </Match>
        </Switch>
    );
}

/**
 * 过程行：chevron + 状态灯 + 标题；正文按 open 渲染。**逐条过程行**（第 4 级铺开 / 过程 bar 展开后）
 * 与**详情层**都用它 —— 直播中的"活动块"不在这里（那由 TailBox 承担：定高体、默认展开、
 * 内容可含正文；两处各写一套必然分叉，R17→R19 已经吃过一次）。
 *
 * 行首 `statusMark` **恒显**（💭 / ⚙ 类字形 + ● 在跑 / ✓ 完成 / ✗ 失败 / ⊘ 中断）：
 * 判据在 `lib/chat-fold.procStatusOf`（**纯函数 + 单测**：`status==="error"` → ✗ 有测试守着 —— ##329），
 * 本文件只把档位映成 class；
 * 少了它，一行 `思考` 与一行 `Bash · 命令` 在长列表里只能靠读文字分辨（2026-10-11 用户口径
 * "给工具和思考 bar 前加前缀图标"）。它同时是**状态位**（● / ✗ / ⊘），不是纯装饰。
 *
 * **行首第一格**：能展开给箭头、不能展开给静态点（见 `expandableOf`）——
 * 思考只有一行时展开体与标题是同一句，点开毫无变化；但格子不能空（左列是齐的层级刻度）。
 * 那一格现在是 `RowGutter`（行首那一列折叠条），**不在行内**：见其头注。
 */
function ProcessRow(props: {
    node: BlockNode;
    /** 所在轮（算工具行的"意图"标题，见 `chat-fold.intentOf`） */
    turn?: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const n = () => props.node;
    /** 这一行**点开会不会多出东西**（思考只有一行就不给展开能力，见 chat-fold.expandableOf） */
    const can = () => expandableOf(n());
    const open = () => can() && procOpenOf(n(), props.pin, viewLive());
    const head = "flex w-full items-center gap-1.5 py-1.5 text-left";
    /**
     * 行头（三种行位共用同一份内容，只是外壳不同）：
     * **能展开** = `DisclosureHead`（可点）；**不能展开** = 静态 `div` —— 不是"按钮"，
     * 读屏不该念成可按。折叠条列恒占位（箭头 或静态点，都由 `RowGutter` 给），左列才是齐的层级刻度。
     */
    const title = () => (
        <>
            {statusMark(n())}
            <span class="font-medium text-base-content/80 truncate flex-1">
                {summaryOf(n(), open(), props.turn)}
            </span>
            <ParamsToggle
                node={n()}
                onOpen={() => {
                    if (!open()) props.onToggle(n().id);
                }}
            />
            <SpentBadge node={n()} />
        </>
    );
    return (
        <div class="text-body" data-block-id={n().id} data-block-tag={n().tag} data-expandable={can() ? "1" : "0"}>
            {/* 竖列折叠条：整块高 + 一个点击区（见 RowGutter 头注）；形状全在皮肤里 */}
            <RowGutter
                can={can()}
                open={open()}
                onToggle={() => props.onToggle(n().id)}
            />
            <Show
                when={can()}
                fallback={
                    <div class={head} data-row-head="1">
                        {title()}
                    </div>
                }
            >
                <DisclosureHead
                    open={open()}
                    onToggle={() => props.onToggle(n().id)}
                    class={`${head} hover:bg-base-200/60`}
                    rest={{ "data-row-head": "1" }}
                >
                    {title()}
                </DisclosureHead>
            </Show>
            <Show when={open()}>
                <div class="pb-2 max-h-72 overflow-auto" data-row-body="1">
                    <ProcBody node={n()} onFull={props.onFull} />
                </div>
            </Show>
        </div>
    );
}

/**
 * **尾行框**：活动（直播中）与**现场**（异常结束后）是同一件东西的两个时刻；它是行序列里
 * `kind: "tail"` 的那一行 —— **任何级别都在**、形状一致（"级别同构"，也是"1 级不变量"里的"错误"）。
 *
 * 用户 2026-10-11 定稿：
 *   · **直播中** = 中间载体，装**所有正在收取中的数据**（text / tool / think），体**定高**
 *     （内容一行行长出来时不顶开屏幕）；标题右侧 `进行中 ⇄ ⋯ 等待下一步…`（跑完不消失、不另起一行）。
 *   · **异常结束**（`sceneTailOf`）= 错误/未完成**现场**：折叠 = 一行标题（错误标题），
 *     展开 = 当时正在跑的东西；1 级也看得见（"1 级不变量"里的"错误"那一项）。
 *   · 末叶子是 error 时：错误作**红条压在框顶**（形如查询 bar 附着 panel 顶），框整体转红 ——
 *     "未收取完成时报错，这个进行中的框就是错误现场"。
 *
 * 为什么两态共用一个组件：它们由 `composeTail` **一处**分解（同一个叶子、内容都不进文档序），
 * 写两套必然出现"直播时一个样、结束后换一个样"（用户最烦的不一致）。
 */
function TailBox(props: {
    /** 尾巴叶子（活动块 / 现场那个叶子）—— 行键与开合状态都挂在它 id 上 */
    node: BlockNode;
    /** 所在轮（工具行标题的"意图"取自同一步前一条 think；等待文案要读本轮是否已停） */
    turn: BlockNode;
    /** 错误条（末叶子是 error 块时） */
    error: BlockNode | null;
    /** 主体：当时正在跑的那个叶子（末叶子是 error 时取它前一个） */
    body: BlockNode | null;
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    onFull: (title: string, content: string) => void;
    md: boolean;
    /** true = 直播中的活动块（定高）；false = 结束后的现场（体可长） */
    live?: boolean;
}) {
    const n = () => props.node;
    // 默认展开：活动块要看着它长，现场要让人看见"折在哪"；用户 pin 仍可覆盖
    const open = () => (n().id in props.pin ? props.pin[n().id]! : true);
    const failing = () => n().tag === "error";
    let bodyRef: HTMLDivElement | undefined;
    // 直播展开时跟随到底（订阅整树信号，每 op 重跑一次）；冻结/现场不跟随（用户翻上去就别拽他）
    createEffect(() => {
        void useContext(ChatViewCtx).trees();
        if (props.live && open() && !n().stopped && bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
    });
    const title = () => {
        const b = n();
        if (b.tag === "error") {
            // 展开时体里就有红条全文，标题不再复述（同一屏看两遍）；收起时标题就是那一眼
            return open() ? "出错现场" : `❌ [${str(b.attrs.source)}] ${firstLine(str(b.attrs.message))}`;
        }
        return summaryOf(b, open(), props.turn);
    };
    /** 此刻在等什么（三档；只有直播才有这句话） */
    const wait = () => waitTextOf(props.turn, n(), !!props.live);
    return (
        <div
            class="text-body"
            data-block-id={n().id}
            data-block-tag={n().tag}
            data-tail-box={props.live ? "live" : "scene"}
            data-failing={failing() ? "1" : undefined}
            data-live-area={props.live ? (n().stopped ? "waiting" : "active") : undefined}
        >
            <RowGutter
                open={open()}
                onToggle={() => props.onToggle(n().id, props.live ? !open() : undefined)}
            />
            <DisclosureHead
                open={open()}
                onToggle={() => props.onToggle(n().id, props.live ? !open() : undefined)}
                class="flex w-full items-center gap-1.5 text-left py-1.5"
                rest={{ "data-row-head": "1" }}
            >
                <Show when={failing()} fallback={statusMark(n())}>
                    <span class="text-error">✗</span>
                </Show>
                <span class="font-medium text-base-content/80 truncate flex-1">{title()}</span>
                {/* 参数开关：直播/现场也要能看（`props.body` 才是那个工具块，`props.node` 是尾叶子） */}
                <Show when={props.body}>
                    {(b) => (
                        <ParamsToggle
                            node={b()}
                            onOpen={() => {
                                if (!open()) props.onToggle(n().id, props.live ? true : undefined);
                            }}
                        />
                    )}
                </Show>
                {/* 开销角标（用户 2026-10-20：「这是模型质量的观测」）：主体那一块自己的耗时 + 体积 */}
                <Show when={props.body}>{(b) => <SpentBadge node={b()} />}</Show>
                <Show when={props.body}>
                    {(b) => (
                        <>
                            <DetachNote node={b()} />
                            <DetachToggle node={b()} />
                        </>
                    )}
                </Show>
                {/* 状态位**只说此刻在等什么**（三档），不再有"进行中"这种什么也没说的词 */}
                <Show when={props.live}>
                    <span class="shrink-0 text-caption opacity-50" data-live-state>
                        <Show when={wait()} fallback={<span class="opacity-0">·</span>}>
                            {(w) => <span class="animate-pulse">{w()}</span>}
                        </Show>
                    </span>
                </Show>
            </DisclosureHead>
            <Show when={open()}>
                <div
                    ref={(el) => (bodyRef = el)}
                    /* 活动块体定高 ≈ 5 行（leading-relaxed 1.625em × 5 ≈ 8.2em），超出在框内滚；
                       现场给 max-h（内容已定，不必用固定高度锁住空白） */
                    class={`pb-2 overflow-auto ${props.live ? "h-[8.2em]" : "max-h-72"}`}
                    data-live-body={props.live ? (n().stopped ? "waiting" : "active") : undefined}
                >
                    <Show when={props.error}>
                        {(e) => (
                            <div class="mb-1" data-error-strip>
                                <ErrorBox node={e()} />
                            </div>
                        )}
                    </Show>
                    <Show when={props.body}>
                        {(b) => <ProcBody node={b()} onFull={props.onFull} live={props.live} md={props.md} />}
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/**
 * **结束点** —— 结尾槽的第三种形态：`completed`（或 `max-tokens`）但末件不是正文，通常是工具。
 *
 * 用户 2026-10-12 R25 拍板：**工具结尾与文本结尾各按自身形态输出** —— 保持工具形态
 * （不复用结论样式）+ 「本轮结束点」tag + **默认收起**，不冒充结论（模型没给文字，
 * 就不该长成一段话）。它同样**自暴露、恒显、与状态行同级**。
 */
function EndLeafBox(props: {
    node: BlockNode;
    /** tag 那句 tooltip —— **必须由调用方用 `turn` 算好传进来**：`endLeafTip` 读的是
     *  `turn.attrs.endReason`，而本组件的 `node` 是**尾叶子**（它同时要拿去画 `ProcBody`），
     *  叶子身上没有 endReason ⇒ 组件内自算会恒走"结束原因未知"那一支，连新记录也这么说
     *  （review ##253 RV-5：纯函数绿、接线错）。 */
    tip: string;
    /** 所在轮（`summaryOf` 算工具行"意图"用；与 `tip` 同源，都由调用方从 turn 喂） */
    turn: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    onFull: (title: string, content: string) => void;
}) {
    const n = () => props.node;
    // 默认**收起**（与结论相反：结论是"这轮说了什么"，要看得见；结束点是"停在哪个工具"，
    // 认得出是哪一步就够，内容要看再点开）—— 用户 pin 可覆盖
    const open = () => (n().id in props.pin ? props.pin[n().id]! : false);
    return (
        <div class="text-body" data-block-id={n().id} data-block-tag={n().tag} data-tail-box="endleaf">
            <RowGutter open={open()} onToggle={() => props.onToggle(n().id, !open())} />
            <DisclosureHead
                open={open()}
                onToggle={() => props.onToggle(n().id, !open())}
                class="flex w-full items-center gap-1.5 text-left py-1.5 hover:bg-base-200/60"
                rest={{ "data-row-head": "1" }}
            >
                {statusMark(n())}
                <span class="font-medium text-base-content/80 truncate flex-1">
                    {summaryOf(n(), open(), props.turn)}
                </span>
                <SpentBadge node={n()} />
                <span
                    class="shrink-0 rounded border border-dashed border-base-300 px-1 text-caption opacity-50"
                    data-tail-tag
                    /* 文案**跟着 endReason 走**（纯函数 `endLeafTip`，由调用方用 turn 算）：
                       旧日志没有 endReason，不能替它断言"正常结束"（##253 RV-3）。 */
                    title={props.tip}
                >
                    本轮结束点
                </span>
            </DisclosureHead>
            <Show when={open()}>
                <div class="pb-2 max-h-72 overflow-auto" data-row-body="1">
                    <ProcBody node={n()} onFull={props.onFull} />
                </div>
            </Show>
        </div>
    );
}

/**
 * 一个 turn 的渲染构成（尾槽模型，用户 2026-10-12 R22；级别语义见 `lib/chat-fold.ts`）：
 *   [轮首用户发言]  `leadUsers` —— 先出（IM 直觉：用户先说、对方再接）
 *   轮次头          身份 + ✗n 角标 + chevron；点它 = **收拢 / 展开这一轮的过程历史**
 *   **过程历史**    `chat-fold.turnRows` 一处产出、同一个 `<For>` 一处渲染（`data-chat-list`
 *                   = 皮肤那条贯穿线的落点）；**`historyOpenOf` 决定整段渲不渲染**
 *   **结尾槽**      `tailOf` 一处判形态：结论 / 结束点 / 现场 / 执行过程 —— **恒显**，
 *                   在历史容器**之外**（贯穿线不穿过它）
 *   结束说明        按 `endReason` 说清"为什么结束"（所有级别恒显）
 *   状态行          时刻（左，纯文本、不可点）+ 统计（纯文本）+ ⚡速度 + 用量按钮（右）
 *
 * 为什么"结尾"单列一层（用户 2026-10-12 R22 口径）：对话 = **执行过程历史 + 执行过程 + 结尾 + 状态**。
 * 结尾（不管成功失败、文本工具）都是"这轮的落点"，**顶级自暴露、与状态同级**；只有过程历史才折叠。
 * v3 之错 = 把错误"转移"进"结尾可展开框"，没留在现场。
 *
 * 恒显项 = **"1 级不变量"**（与级别无关）：用户发言 · 轮次头 · 结尾槽 · 状态行 · 结束说明。
 * 其中"结论"的判据是 `chat-fold.conclusionOf`（**文档序最后一个非用户叶子恰是助理正文**）
 * —— 旧判据"最后一条正文"是错的：中途被打断的轮会把一句过程话当结论（2026-10-11 用户实测）。
 *
 * 身份（🤖 头像 · 人物 · 模型 · 思考级别）是**该轮事实**的投影（`turn.attrs.model` /
 * `reasoningEffort`），不是当前配置 —— 否则改一次 personas.yaml 全部历史署名被一起改写
 * （任务 196 的教训）。**任何级别都显示身份**（1 级与 2 级必须一致）。
 *
 * 行**不重排**：只做"藏中间过程"，用户发言/插话/error 一律就地渲染（见 chat-fold.ts）。
 */

/** 该轮耗时（main 收尾 patch 写入的 `durationMs`）；没写（旧日志 / 崩溃轮）→ null，不编 0 */
function turnDurationMs(t: BlockNode): number | null {
    const d = t.attrs.durationMs;
    return typeof d === "number" ? d : null;
}

function fmtDuration(ms: number): string {
    return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms}ms`;
}

/**
 * 「这轮发生了什么」一行字：`6 步 · 12 秒 · ⚙ 5 · 💭 6 · ❌ 1`。
 *
 * 语义上属于**轮次**（不是某条消息），但视觉上归**轮尾**（时刻右侧、用量按钮左边）——
 * 用户 2026-10-11 口径："把人物右侧的统计放到下面、用量的左边，不用 hover"：
 *   · 放轮次头右侧时它跟身份挤在一行，读起来像名字的后缀；轮尾那行本来就"总结这一轮"；
 *   · 它不能可点（没有"更多信息"可给），而轮次头整行是开合按钮 —— 摆在里面就成了
 *     "点统计也换层"，与轮尾时刻同理（滚屏阅读时最易误触）。
 * 与用量按钮**分开**：用量要 hover/点击，统计纯文本，两者语义不同（同轮尾时刻的处理）。
 *
 * 判据（都是 review 或用户口径换来的）：
 *   · **不放 token**：用量按钮就在右边，同一行说两遍；
 *   · **不放 `n/4`**：级别归顶部那个全局按钮，单轮只有开/合两态（见 TurnHeader 头注）；
 *   · 报错要有位置：一屏多轮时先看见"哪轮出过事"最快（error 块本身是恒显行，见 chat-fold.turnRows）。
 */
function turnStatLine(t: BlockNode, c: { step: number; tool: number; think: number; error: number }): string {
    const parts: string[] = [];
    if (c.step) parts.push(`${c.step} 步`);
    const d = turnDurationMs(t);
    if (d != null) parts.push(fmtDuration(d));
    if (c.tool) parts.push(`⚙ ${c.tool}`);
    if (c.think) parts.push(`💭 ${c.think}`);
    if (c.error) parts.push(`❌ ${c.error}`);
    return parts.join(" · ");
}

/**
 * 轮次头（人物标题 bar）：身份 + 开合箭头。点它 = **这一轮**收拢 / 展开。
 *
 * 身份（🤖 头像 · 人物 · 模型 · 思考级别）**任何级别都显示** —— 用户 2026-10-11 口径：
 * "1 级的人物 bar 和 2 级不一样，需要一致，也需要显示人物/模型信息"。
 * 身份是**该轮事实**的投影（`turn.attrs.model` / `reasoningEffort`），不是当前配置 ——
 * 否则改一次 personas.yaml，全部历史署名被一起改写（任务 196 的教训）。
 *
 * **统计不在这里**（步数 · 耗时 · ⚙ n · 💭 n · ❌ n）：搬到轮尾一行、用量按钮左边
 * （用户 2026-10-11 口径，判据见 `turnStatLine`）。这里只剩身份 —— 一行两件事本来就挤，
 * 而且整行是开合按钮，统计摆进来会被读成"点了会出更多数字"。
 * 它仍进 `ariaLabel` / `title`：读屏与 hover 时"这轮发生了什么"是有用的。
 */
function TurnHeader(props: {
    /** 轮次 id（节点按 id 现取：行对象按 id 复用，见文件头注） */
    turnId: string;
    /** **过程历史**开合（不是级别：级别只改"历史里显示多少"，见 `historyOpenOf`） */
    open: boolean;
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
    /** 视觉上不画（在轮尾），但读屏/hover 文案要 —— `turnStatLine` 的唯一第二调用点 */
    const stat = () => turnStatLine(t(), props.counts);
    const open = () => props.open;
    return (
        <DisclosureHead
            open={open()}
            onToggle={props.onToggle}
            class="flex items-center gap-1.5 w-full text-left rounded-lg px-1.5 py-1 hover:bg-base-200/60 text-body"
            ariaLabel={`${info().name ?? "助理"}${info().model ? `（${personaStore.displayModel(info().model)}）` : ""}：${stat()}；${turnFoldTip(open())}`}
            rest={{
                "data-testid": "turn-header",
                "data-row-head": "1",
                "data-block-id": t().id,
                "data-block-tag": "turn",
                "data-open": open() ? "1" : "0",
                "data-inferred": info().inferred ? "1" : undefined,
                title: `${turnFoldTip(open())}\n${info().title}`,
            }}
        >
            {/* 开合手柄在**行首 gutter**（`RowGutter`）：一轮里"轮次头 → 过程 bar → 逐条过程"
                三级同列左对齐，一眼能看出层级（2026-10-11 用户口径：箭头从右边换到左边；
                2026-10-12 用户口径：竖列成一列，见 RowGutter 头注） */}
            <RowGutter open={open()} onToggle={props.onToggle} />
            {/* 身份：**所有级别都显示**（1 级与 2 级必须一致，用户 2026-10-11 口径） */}
            <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-body"
                aria-hidden="true"
            >
                🤖
            </span>
            {/* min-w-0 + truncate（review2-1）：多 view 并排时单栏只有 200~260px，模型名
                （`provider/model`）很长，会把这条 flex 行撑成两行、甚至顶破容器右缘 ——
                `min-width:auto` 是默认值，不加就永远不缩。真正长的是模型名，所以它先被截。 */}
            <Show when={info().name}>
                <span class="min-w-0 truncate font-medium">{info().name}</span>
            </Show>
            <Show when={info().model}>
                <span class="shrink-0 opacity-50">·</span>
                <span class="min-w-0 truncate opacity-60">{personaStore.displayModel(info().model)}</span>
            </Show>
            {/* 思考级别：该轮实际生效的档位（main 写入 turn meta） */}
            <Show when={effort() && effort() !== "none"}>
                <span class="opacity-50">·</span>
                <span class="opacity-60">{reasoningEffortLabel(effort() as ReasoningEffort)}</span>
            </Show>
            <Show when={info().inferred}>
                <span class="shrink-0 opacity-40">（当时人物未知）</span>
            </Show>
            {/* 过程历史里的失败/中断数 —— 历史收起时这是**唯一**的线索（用户 2026-10-12 R22：
                中间步骤的错误不单列根级，"只在树各层的图标/颜色上标注"） */}
            <Show when={props.counts.error > 0}>
                <span
                    class="shrink-0 rounded border border-error/40 bg-error/10 px-1 font-mono text-caption text-error"
                    data-head-err
                    title={`过程历史里有 ${props.counts.error} 处失败/中断（展开可见）`}
                >
                    ✗ {props.counts.error}
                </span>
            </Show>
            {/* 该轮时刻**不在这里**：它在轮尾状态行（★ 状态行，见 UsagePanel 的 Clock）——
                一轮只该出现一次，且要跟统计/用量/速度同列可扫。 */}
            {/* 统计不在这里：轮尾一行（时刻右边、用量左边）—— 见 turnStatLine 头注 */}
        </DisclosureHead>
    );
}

/**
 * **助理正文行** —— 所有级别共用同一个组件，级别只决定 `clamp`（"级别同构"的落点之一）。
 *
 * `clamp`（1 级的结论）压成 N 行摘要、点提示行进下一级看全；`!clamp`（2 级起 + 3-4 级的
 * 中间正文）一律全文。
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
function TextRow(props: {
    node: BlockNode;
    /** 折叠判据：正文行数超过它才给折叠能力（草图 v4 = 3 行） */
    lines: number;
    /** **缺省**开合（用户的 pin 优先）：结论 = 2 级起开、1 级折；过程历史正文 = 恒开 */
    defaultOpen: boolean;
    /** 开合状态（与过程行同一套 pin）—— **点自己这一块**，不是换级别、更不是折别人 */
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    md: boolean;
    /** 结尾槽的「结论」形态：这一块**自己就是** `[data-tail-box=conclusion]`（草图 v4 的
        `.tailbox.k-conc` 就是这一块，不再包一层 —— 包一层就是槽里那张卡还套一张卡） */
    box?: "conclusion";
    /** **仅结论行**：拖下缘改「可见行数」（= 1 级摘要的可视高度）。给了才渲染拖条 ——
     *  过程历史里的正文行（`HISTORY_TEXT_FOLD_LINES` 固定）不给，它们的高度不归用户调。 */
    onResizeLines?: (n: number) => void;
}) {
    const b = () => props.node;
    /** 正文宿主（拖拽时量它当前高度 —— 等比换算的基准，见 `linesFromDrag`） */
    let bodyRef: HTMLDivElement | undefined;
    const raw = () => str(b().attrs.content);
    /** 能不能折 = **"点开真的会多出东西"**（review ##253 RV-6）。
     *  原来按**原始**行数判（`countLines(raw()) > lines`），而 `clampLines` 已跳过前导空行
     *  （RV-2 的修复）⇒ 以空行开头的正文会给出一个"点开毫无变化"的箭头。
     *  现在直接取 `clampLines` 的 `omitted` —— 与"真截"**同源**，不再有第二套口径。 */
    /** 全文行数：**按块版本 memo**（块不变就不重算）—— 直播中的大块每帧付一次 `countLines`，定稿后只算一次 */
    const totalLines = createMemo(() => countLines(raw()));
    /** 截断结果同样 memo：原来 `canFold()` 与 `view()` **各算一次** `clampLines` ⇒ 每帧两遍全文 split（##93） */
    const clamped = createMemo(() => clampLines(raw(), props.lines, totalLines()));
    const canFold = () => clamped().omitted > 0;
    const open = () => (b().id in props.pin ? props.pin[b().id]! : props.defaultOpen);
    // 直播中的正文不折：它还在长，折叠只会来回跳；定稿后才折成摘要
    const folded = () => canFold() && b().stopped && !open();
    const view = () => (folded() ? clamped() : { text: raw(), omitted: 0, exact: true });
    const cut = () => view().omitted > 0;
    /** 点**这一块**（正文行自己那条竖列折叠条 / 提示行）—— 用户 2026-10-12 R6 报的 bug：
     *  原来结论槽把 `onExpand` 接到了"换级别"，点一下**把工具历史折了、自己没变**。 */
    const fire = () => props.onToggle(b().id, !open());
    /** 折叠条的无障碍名：只读"展开 / 收起"听不出是**哪一行**（review ##253 小项6） */
    const foldLabel = () => `${folded() ? "展开" : "收起"}${props.box === "conclusion" ? "结论" : "正文"}`;
    /** 结论下缘拖拽：改的是**全局**摘要行数（1 级所有轮次一起变 —— 它是"我习惯看几行"的偏好，
     *  与顶部 `n/4 展开` 同级，不是逐轮覆盖；逐轮覆盖不落盘，见 ui-state 头注）。
     *  起点量一次宿主高度，之后按等比换算出行数（纯函数 `linesFromDrag`）。 */
    const startResize = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const onResize = props.onResizeLines;
        const el = bodyRef;
        if (!onResize || !el) return;
        const h0 = el.getBoundingClientRect().height;
        const n0 = props.lines;
        const startY = e.clientY;
        const move = (ev: MouseEvent) =>
            onResize(linesFromDrag(n0, h0, ev.clientY - startY, CONCLUSION_LINES_MIN, CONCLUSION_LINES_MAX));
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };
    /** 拖条只在**结论收起态**给（拖它 = 改"1 级看几行"）：展开态（2 级全看）没有高度可调；
     *  未定稿（还在长）也不给 —— 高度每帧变，拖了没有稳定基准。 */
    const canResize = () => props.box === "conclusion" && !!props.onResizeLines && !open() && b().stopped;
    return (
        <div
            data-block-id={b().id}
            data-block-tag="text"
            data-tail-box={props.box}
            data-clamped={cut() ? "1" : undefined}
            data-text-open={open() ? "1" : "0"}
        >
            <RowGutter
                /* 直播中的正文不折（见 `folded`）⇒ 那时**不承诺**可展开：给静态点，不给箭头
                   （箭头 + `aria-expanded` 会说"收起"，而正文本来就是全的 —— 点了当帧无变化）。 */
                can={canFold() && b().stopped}
                /* 显示态取 `folded()`（真截断了才算"收起"），与下面 `view()` 同一个判据 */
                open={!folded()}
                label={foldLabel()}
                onToggle={fire}
                /* 正文行**没有行头控件**（正文本身就是内容，不是 DisclosureHead）⇒ 条是它唯一的
                   键盘入口，给 `sole`。但收起态那条"⋯ 已折叠 N 行 · 点击展开全部正文"是可见按钮，
                   已经有停靠点 ⇒ 那时条退回装饰（免得同一行动作两个 tab 停靠点）。 */
                sole={!cut()}
            />
            <div
                ref={(el) => (bodyRef = el)}
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
                    onClick={fire}
                >
                    ⋯ 已折叠 {view().exact ? "" : "≥"}{view().omitted} 行 · 点击展开全部正文
                </button>
            </Show>
            {/* 1 级「摘要结论」下缘拖条：往下拖 = 这一块画更多行（免在 1/2 级间来回切）。
                全局偏好（所有轮次一起变），tooltip 说清；`data-concl-resize` 供 CDP 定位。 */}
            <Show when={canResize()}>
                <div
                    class="group mt-1 flex h-2 cursor-row-resize items-center justify-center rounded hover:bg-primary/20 active:bg-primary/40"
                    data-concl-resize={String(props.lines)}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`拖动调整 1 级摘要高度（当前 ${props.lines} 行）`}
                    title={`拖动调整「1 级摘要」高度（当前 ${props.lines} 行；往下拖看更多，全局生效）`}
                    onMouseDown={startResize}
                >
                    <span class="h-0.5 w-10 rounded-full bg-base-content/20 group-hover:bg-base-content/50" />
                </div>
            </Show>
        </div>
    );
}

/**
 * 用户发言气泡：一切档位/模式下都全文 —— 它就是"我说过啥"的脉络本体。
 *
 * 对齐 = **谁说的**（##166 §40 C）：
 *   · **无 `author`**（本任务本人在任务对话页里发的）⇒ **右对齐，逐字不变**（老行为）；
 *   · **有 `author`**（代发 / 多 agent 同席：room 投递、CLI `--author`、驱动环）⇒ **左对齐 + 署名行 + 色点**，
 *     与助手气泡同侧 —— 因为那句话在本会话里**不是我说的**，右边那套语义（"我说过啥"）会撒谎。
 * 色点走 `memberColor`（与房间成员栏**同一份**配色判据，同 id 到哪都一样色），不写死色值。
 */
function UserBubble(props: { node: BlockNode }) {
    const b = () => props.node;
    const steer = () => str(b().attrs.steer);
    /** 发言者成员 id（`agent:166` / `human:ccc`）；空 = 本任务本人 */
    const author = () => str(b().attrs.author);
    /** 房间来源（`{ roomId, sayId }`）；空 = 不是投递来的（第 23 刀） */
    const roomOrigin = () => roomOriginOf(b().attrs);
    /** 「房间投递 · #N」文案；`null` = 不画 */
    const deliveryNote = () => deliveryBadge(roomOrigin());
    /** 这句话的时刻：块 id 自带所属轮（turnId 内嵌毫秒），格式复用 agent 侧那个 `fmtTurnStamp`。
     *  取不到就不显示（绝不用渲染时刻顶替）—— 数据源与降级口径见 `lib/user-stamp` 头注。 */
    const stamp = () => userStamp(b().id);
    return (
        <div class={bubbleAlignClass(author(), roomOrigin())}>
            <div class="max-w-[85%] bg-primary/10 border border-primary/20 rounded-2xl px-3.5 py-2 text-prose whitespace-pre-wrap break-words">
                {/* 房间投递标记（##377 第 23 刀）：这句话**不是本任务的人说的** —— 是别的房间投过来的。
                    为什么要标：接收方原来分不清「本任务的人在跟我说话」与「别的房间投来的一句」，
                    那条 user 块看起来就是这个任务自己的发言。标记只写来源（房间短名），不写原因。 */}
                <Show when={deliveryNote()}>
                    {(n) => (
                        <div class="mb-0.5 flex items-center gap-1.5 text-caption opacity-70" data-user-room={roomOrigin()?.roomId}>
                            <span class="shrink-0">🫧</span>
                            <span class="font-medium">{n()}</span>
                        </div>
                    )}
                </Show>
                <Show when={hasAuthor(author()) ? author() : null}>
                    {(a) => (
                        <div class="mb-0.5 flex items-center gap-1.5 text-caption" data-user-author={a()}>
                            <span
                                class="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: memberColor({ id: a(), color: undefined }) }}
                            />
                            <span class="font-medium opacity-80">{shortName(a())}</span>
                            <span class="opacity-40">{a()}</span>
                        </div>
                    )}
                </Show>
                <Show when={steer()}>
                    <span class="mb-0.5 block text-caption opacity-60">
                        ⤵ 插话（{steerModeLabel(steer())}）{steerModeTip(steer())}
                    </span>
                </Show>
                {str(b().attrs.content)}
                {/* 时刻压在气泡内右下（IM 惯例）：与 agent 侧同格式，不另起一行占版面 */}
                <Show when={stamp()}>
                    {(s) => (
                        <div class="mt-0.5 text-right text-caption opacity-50" data-user-stamp title={s().title}>
                            {s().text}
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}

/**
 * 过程 bar（3 级起）：**一段连续的思考/工具**折成一行（切法见 `chat-fold.contentItems`）。
 *
 * 行首形状（2026-10-11 用户口径定稿）：`chevron ▸ · 💭 n · ⚙ n [✗] · │ · 首行内容`——
 *   · **计数在 chevron 右边、内容左边**（原在右侧）：短、定宽、永远是数字，压在行首才扫得出
 *     "整页哪几轮重"；而且**展开/收起都在**，同一位置同一形状，不随开合消失。
 *   · **不再写「过程」二字**：那是"展开后不留空"的补丁标题，现在行首恒有计数 ICON，不空。
 *   · **计数块带底色 chip**，收起态再接一个 `│` 分隔，把计数与后面那段首行内容从视觉上切开
 *     （否则 `💭 1 · ⚙ 2 首行内容` 读成一串，看不出前半是统计）。
 *   · **不再顶 `statusMark`**（R15 加过）：计数块已经带 `💭`/`⚙` 字形，前面再顶一个是同一行
 *     图标叠两遍（R12 删掉同一处图标串的判据）；"这段跑没跑完"由失败 `✗` 与直播轮的实时区
 *     （那边有 statusMark，因为它画的是**单个**节点）负责。
 *
 * 收起 = 计数 + 该段**第一个**过程的内容（思考首行 / `tool · 命令首行`）；
 * 展开 = 只剩计数（下面铺开的就是那第一行，标题再复述一遍就是同一屏看两遍），逐条单行与
 * 4 级那一行长得一样：`open` 不跟级别走死 —— **用户的 pin 优先，否则跟 4 级**
 * （整体切到 4 级 = 所有 bar 都开，单点某一行 = 只开这一行，共用同一套渲染，不会各说各话）。
 *
 * bar 里**只有过程**：助理正文各自成项（3 级起全文）—— 正文与过程一旦合并，
 * 顺序就会出错（上一版把正文收进这一行的教训）。
 */
function ProcBar(props: {
    /** 这一段连续的过程叶子（文档序）——数组引用稳定是 `<For>` 不重建的前提（见 reuseRows） */
    parts: BlockNode[];
    /** 所在轮：透传给 `summaryOf` 算工具行标题的"意图" */
    turn?: BlockNode;
    open: boolean;
    /** 点整行 = 切这一行的 pin（**不是**换级别：级别循环归顶部按钮） */
    onToggle: () => void;
    pin: Record<string, boolean>;
    onToggleProc: (id: string) => void;
    onFull: (title: string, content: string) => void;
}) {
    const thinks = () => props.parts.filter((n) => n.tag === "think").length;
    const tools = () => props.parts.filter((n) => n.tag === "tool").length;
    const failed = () => props.parts.some(isFailedTool);
    /** 计数块的读屏/自动化文案（图标的字形读屏念不出来）；**两个计数恒在**（见下） */
    const countsText = () => `${thinks()} 段思考、${tools()} 个工具`;
    return (
        <div
            data-block-tag="proc-bar"
            /* 行键 = 该段**首个叶子** id（与 pin 的 `row:` 前缀同一来源）；加 `_bar` 后缀 ——
               这块是"一段过程"的容器，不是那个叶子本身，id 不该与子行撞车（同一份 DOM 里
               两个 `[data-block-id]` 同值，调试/选择器都会指错人）。 */
            data-block-id={`${props.parts[0]?.id ?? "proc"}_bar`}
            data-has-error={failed() ? "1" : undefined}
            data-open={props.open ? "1" : "0"}
        >
            <RowGutter open={props.open} onToggle={props.onToggle} />
            <DisclosureHead
                open={props.open}
                onToggle={props.onToggle}
                class="flex items-center gap-1.5 w-full py-1 pr-1 hover:bg-base-200/60 text-body"
                ariaLabel={`过程：${countsText()}（点击${props.open ? "收起" : "展开"}这一行）`}
                rest={{ "data-row-head": "1" }}
            >
                {/* 计数在**行首**：展开/收起都在（同一位置同一形状，不随开合消失），
                    带底色 chip = 与后面的首行内容分开（见头注） */}
                <span
                    class="shrink-0 rounded bg-base-300/60 px-1 tabular-nums text-caption opacity-70"
                    data-proc-counts={countsText()}
                    title={countsText()}
                >
                    {/* **两个计数恒在**（为 0 也写）：各段的计数块同宽同位，扫一眼就能比"哪段重"；
                        只写非零那个，第一段（只有思考）就比后面的窄一截，看着像两种行
                        （用户 2026-10-11 口径："甚至为 0 都要有，方便对齐和视觉概念上的统一"）。 */}
                    {`💭 ${thinks()} · ⚙ ${tools()}`}
                    <Show when={failed()}>
                        <span class="ml-1 text-error" title="这一行里有失败的工具">
                            ✗
                        </span>
                    </Show>
                </span>
                {/* 收起态才有"内容"可写（首行内容），故分隔符与内容一起只在收起态出现 */}
                <Show when={!props.open && props.parts[0]}>
                    <span class="shrink-0 opacity-25" aria-hidden="true">
                        │
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/80">
                        {summaryOf(props.parts[0], false, props.turn)}
                    </span>
                </Show>
            </DisclosureHead>
            {/* **子层在卡内**（包含关系）：卡 = 块自己，子行缩进在卡的留白里 —— 这样父卡
                （含它那道 4px 色条 / 贯穿线）覆盖的是**整段**，而不是"只有行头那一行"。
                缩进量由皮肤给（card = 父卡留白 20px；rail = 线 + 缩进，见 index.css）。 */}
            <Show when={props.open}>
                <div class="space-y-0.5" data-proc-children="1">
                    <For each={props.parts}>
                        {(n) => (
                            <PartRow
                                node={n}
                                turn={props.turn}
                                pin={props.pin}
                                onToggle={props.onToggleProc}
                                onFull={props.onFull}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

/**
 * 过程 bar 铺开后的**逐条**：过程 → 单行（各自再点开才是内容 = 第 5 层）；plan / 未知块照实画。
 *
 * 每行**照带** chevron + 状态灯（`ProcessRow` 的默认形状）：外层 bar 只说"这一段有几段思考、
 * 几个工具"，逐条里"哪条是思考、哪条还在跑/失败"只能由每行自己说（2026-10-11 用户口径）。
 */
function PartRow(props: {
    node: BlockNode;
    /** 所在轮（见 `summaryOf` 的 `turn`） */
    turn?: BlockNode;
    pin: Record<string, boolean>;
    onToggle: (id: string, force?: boolean) => void;
    onFull: (title: string, content: string) => void;
}) {
    const b = props.node;
    if (b.tag === "think" || b.tag === "tool") {
        return (
            <ProcessRow
                node={b}
                turn={props.turn}
                pin={props.pin}
                onToggle={props.onToggle}
                onFull={props.onFull}
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
/** 从错误原文里抠 `trace_id: <id>`（上游回执格式，见 ##309）：缺则无深链 */
function traceIdOf(msg: string): string | null {
    const m = msg.match(/trace_id[:\s]+([0-9a-fA-F_-]{8,})/);
    return m ? m[1]! : null;
}

function ErrorBox(props: {
    node: BlockNode;
    /**
     * 该块所属回执轮的 `steerId`（`steer/N`）。
     *
     * 为什么要外部传：`steerId` 落在**轮块**上（`enqueueWhileRunning` 的 start op），
     * 而本组件拿到的是**子** error 块（`<turnId>_queued`）—— `BlockNode` 没有父指针，
     * 拿不到就是拿不到（渲染层不重建 main 的块树）。
     */
    receiptSteerId?: string;
}) {
    const source = str(props.node.attrs.source);
    const msg = () => str(props.node.attrs.message);
    const tid = () => traceIdOf(msg());
    // 出错的那条请求：主进程在记错误块时把它的记录 id 一并写进 meta.reqId，
    // 这里直接拿它定位（比从错误文本里抠 trace_id 更准）。
    const reqId = () => {
        const v = props.node.attrs.reqId;
        return typeof v === "number" ? v : null;
    };
    // 排队回执（`meta.source === "queue"`，##306）走 error 块**只是通道选择**
    // （error 块不进 LLM 投影），语义却是**正常态**——"生成中，这条已排队"。
    // 画成红色 + ❌ 会被读成失败：##307 让回执全体窗口可见后误读面更大，故按 source 降级成普通提示条。
    // （`meta` 由 BlockStore 摊平进块字段，故这里读的是 `attrs.source`。）
    if (source === "queue") {
        // "已排队"只在那条留言**还在队列里**时才是实话（判据 `receiptStateOf`，同源可单测）。
        // 投递之后它仍挂在对话尾部（回执轮排在最末），口气却还写着"本轮结束后自动投递"——
        // 用户 2026-10-17：「留言已经发出去了，这个还在输入框上面悬着？」⇒ 降级成历史回执。
        // `steerId` 优先取外部传来的（轮块上的那个），退到块自己的 attrs（若有）
        const steerId = () =>
            props.receiptSteerId ?? (typeof props.node.attrs.steerId === "string" ? (props.node.attrs.steerId as string) : "");
        const delivered = () => receiptStateOf(steerId(), localChatStore.steers.map((s) => s.id)) === "delivered";
        return (
            <Show
                when={!delivered()}
                fallback={
                    <div
                        class="rounded-lg border border-base-300/50 bg-base-200/25 px-3 py-1 text-caption text-base-content/40"
                        title={msg()}
                        data-block-id={props.node.id}
                        data-block-tag="error"
                        data-source="queue"
                        data-receipt="delivered"
                    >
                        🗨 已投递
                    </div>
                }
            >
                <div
                    class="rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-body text-base-content/70 whitespace-pre-wrap"
                    data-block-id={props.node.id}
                    data-block-tag="error"
                    data-source="queue"
                    data-receipt="queued"
                >
                    {`⏳ ${msg()}`}
                </div>
            </Show>
        );
    }
    return (
        <div
            class="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-body text-error"
            data-block-id={props.node.id}
            data-block-tag="error"
        >
            <div class="whitespace-pre-wrap">{`❌ [${source}] ${msg()}`}</div>
            {/* 深链：错误块是「用户实际看到出错」的地方，从这里一步到实际请求/响应 ——
                否则用户看到一行原文、却不知去哪查。source 为 `llm` 的错恒给入口；
                有 reqId 就精确打开那条请求，否则退到按 trace_id 找、再退到最近一次失败。 */}
            <Show when={source === "llm" || tid()}>
                <button
                    class="mt-1 text-caption underline decoration-dotted hover:no-underline cursor-pointer"
                    data-testid="error-traffic-link"
                    onClick={() => trafficStore.openWith({ traceId: tid(), reqId: reqId() })}
                >
                    {tid()
                        ? `查看实际请求 / 响应（trace_id ${tid()!.slice(0, 8)}…）→`
                        : "查看实际请求 / 响应 →"}
                </button>
            </Show>
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
            // 排队回执是正常态，不计入"出过事"的红 ✗ 计数（见 ErrorBox 的降级判据）
            else if (c.tag === "error" && str(c.attrs.source) !== "queue") error++;
            walk(c);
        }
    };
    walk(turn);
    return { step, tool, think, error };
}

export function TurnView(props: {
    /** 轮次 id（节点按 id 现取 —— 行对象按 id 复用，见文件头注） */
    turnId: string;
    /** 过程**详情**层的开合（用户自己点出来的那一下；与级别无关） */
    pin: Record<string, boolean>;
    /** **全局**展开级别（1-4，见 lib/chat-fold 的 TurnLevel）—— 决定结论是否压摘要、过程 bar 是否铺开 */
    level: TurnLevel;
    /** 这一轮的**过程历史**开不开（人物栏那枚 chevron / 全局级别，见 `historyOpenOf`） */
    histOpen: boolean;
    /** 点轮次头 = **收拢 / 展开这一轮的历史**（不换层；层归顶部那个全局按钮） */
    onCycle: () => void;
    /** 1 级结论摘要的行数（拖结论下缘改它，见 `onResizeLines`） */
    conclusionLines: number;
    /** 结论下缘拖拽 → 新的摘要行数（页面级：改全局偏好并落盘） */
    onResizeLines: (n: number) => void;
    onToggle: (id: string, force?: boolean) => void;
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
    const isLiveTurn = () => props.liveTurnId != null && props.liveTurnId === t().id;
    /** 直播中：本轮已出助理内容、但 main 还没写过 usage patch → 轮尾那行先出**占位**
     *  （时间由 turnId 自带，用量要等第一步 finish-step）。判据与"等待响应"loading 互补：
     *  助理内容一出现，占位条即接管，界面不再"什么都没有"。 */
    const usagePending = () => !t().attrs.usage && isLiveTurn() && hasAssistantContent(t());
    /** **活动块**（仅直播轮次）= 文档序最后一个非用户叶子（think / tool / **text** …，见 chat-fold） */
    const liveNode = () => liveTailOf(t(), isLiveTurn());
    /** **结尾槽**：直播 = 执行过程；已结束 = 现场 / 结论 / 结束点。判据只在 chat-fold（`tailOf`） */
    const tail = () => tailOf(t(), liveNode());
    /** 现场/活动框的分解（错误条 vs 主体）—— 只有 scene / live 两种形态用得上 */
    const composed = () => composeTail(t(), tail()?.node ?? null);
    /** 上帧的行序列：跨次渲染复用未变的行（`<For>` 按引用 diff —— 不复用就是每帧重建 = 点击全丢） */
    let prevRows: TurnRow[] = [];
    /** 正文行序列 —— **一条路径、所有级别同构**（见 chat-fold.turnRows） */
    const rows = () => {
        const next = turnRows(t(), liveNode());
        prevRows = reuseRows(prevRows, next);
        return prevRows;
    };
    const counts = () => countTags(t());
    /** 过程 bar 的开合：用户的 pin 优先，否则跟 4 级。键加 `row:` 前缀 —— 行键 = 该段首个叶子 id，
     *  不加前缀会与那个叶子自己的过程 pin 撞车（点过程变成连整段 bar 一起开合）。 */
    const rowOpen = (key: string) => {
        const p = props.pin[`row:${key}`];
        return p === undefined ? plan().midExpanded : p;
    };
    return (
        <div class="space-y-1.5" data-turn-id={t().id} data-turn-level={props.level} data-hist-open={props.histOpen ? "1" : "0"}>
            {/* 轮首用户发言**先出**：IM 直觉是"用户先说、对方再接"。
                轮次头（助理身份行）压在用户消息上面 = 看着像助理先开口（2026-10-11 反馈）。 */}
            <For each={lead()}>{(n) => <UserBubble node={n} />}</For>
            <TurnHeader turnId={props.turnId} open={props.histOpen} onToggle={props.onCycle} counts={counts()} />
            {/* ── 过程历史（**可折叠**：人物栏 chevron / 全局 1-4 级）────────────────
                这是**唯一**的折叠容器（`data-chat-list`）：皮肤那条"贯穿线"就画在它上面，
                所以开头有、结尾槽与状态行**在它之外**（线不穿过结尾 —— 用户 2026-10-12 R22：
                结尾是"顶级、自暴露、与状态同级"，不是历史的一部分）。
                `pl-2`：箭头移到行首后，左列箭头的缩进就是层级刻度
                （轮次头 → 过程 bar → 逐条过程），8px 才读得出"bar 在轮次头之下"。 */}
            <Show
                when={props.histOpen}
                /* 收起态（1-2 级 / 用户手动收拢这一轮）：过程不显示，但**用户发言恒显**。
                   用户 2026-10-21：「1/2/3/4 级都没有我那条留言，我需要展开 1 就能看到，
                   这是用户级留言，不应该被折叠放到深层」—— 自己说的话是对话脉络本体，
                   不是"过程细节"，收起来只会被读成"发出去了但丢了"。 */
                fallback={
                    <div class="space-y-1.5" data-chat-list="users-only">
                        <For each={collapsedRows(rows())}>
                            {(row) => (row.kind === "user" ? <UserBubble node={row.node} /> : null)}
                        </For>
                    </div>
                }
            >
                <div class="space-y-1.5" data-chat-list>
                    <For each={rows()}>
                    {(row) => {
                        if (row.kind === "user") return <UserBubble node={row.node} />;
                        if (row.kind === "error")
                            return (
                                <ErrorBox
                                    node={row.node}
                                    receiptSteerId={
                                        isReceiptTurn(t()) && typeof t().attrs.steerId === "string"
                                            ? (t().attrs.steerId as string)
                                            : ""
                                    }
                                />
                            );
                        if (row.kind === "text")
                            return (
                                <TextRow
                                    node={row.node}
                                    lines={HISTORY_TEXT_FOLD_LINES}
                                    defaultOpen={true}
                                    pin={props.pin}
                                    onToggle={props.onToggle}
                                    md={props.md}
                                />
                            );
                        return (
                            <ProcBar
                                parts={row.parts}
                                turn={t()}
                                open={rowOpen(row.key)}
                                /* **显式**给反值：`pin` 缺省时翻转出来是 `!undefined = true`，
                                   而 4 级这行**默认就是展开** —— 不显式传 force 的话第一次点
                                   毫无变化（要连点两下才收起）。与 TailBox 同一个坑，见 togglePin。 */
                                onToggle={() => props.onToggle(`row:${row.key}`, !rowOpen(row.key))}
                                pin={props.pin}
                                onToggleProc={props.onToggle}
                                onFull={props.onFull}
                            />
                        );
                    }}
                    </For>
                </div>
            </Show>
            {/* ── 结尾槽（**自暴露 · 恒显 · 不受历史折叠影响**，与状态行同级）────────────
                形态由 `tailOf` 一处判：结论 / 结束点 / 现场 / 执行过程。节点按 id 现取
                （直播时它是每帧换引用的流式节点；内容与错误条由 `composeTail` 一处分解）。 */}
            <Show when={tail()}>
                {(tl) => (
                    <Switch>
                        <Match when={tl().kind === "conclusion"}>
                            {/* 结论 = **这一块**（`[data-tail-box=conclusion]`）：缺省开合跟级别
                                （1 级折、2 级起全），**点它折的是它自己**（用户 R6 报的 bug）。 */}
                            <TextRow
                                node={leafById(props.turnId, tl().node.id)}
                                lines={props.conclusionLines}
                                defaultOpen={!plan().conclusionClamped}
                                pin={props.pin}
                                onToggle={props.onToggle}
                                md={props.md}
                                box="conclusion"
                                onResizeLines={props.onResizeLines}
                            />
                        </Match>
                        <Match when={tl().kind === "endleaf"}>
                            {/* `tip` 用 **turn** 算（`endReason` 只在 turn 上）—— `node` 是尾叶子，
                                两者不是一回事（review ##253 RV-5）。 */}
                            <EndLeafBox
                                node={leafById(props.turnId, tl().node.id)}
                                tip={endLeafTip(t())}
                                turn={t()}
                                pin={props.pin}
                                onToggle={props.onToggle}
                                onFull={props.onFull}
                            />
                        </Match>
                        <Match when={true}>
                            <div data-tail-row={tl().kind}>
                                <TailBox
                                    node={leafById(props.turnId, tl().node.id)}
                                    turn={t()}
                                    error={composed()?.error ?? null}
                                    body={composed()?.body ?? null}
                                    pin={props.pin}
                                    onToggle={props.onToggle}
                                    onFull={props.onFull}
                                    md={props.md}
                                    live={tl().kind === "live"}
                                />
                            </div>
                        </Match>
                    </Switch>
                )}
            </Show>
            {/* 结束状态说明（所有级别恒显 = "1 级不变量"）：按 endReason 说清"模型说完了 /
                被步数掐 / 输出截断 / 被中断 / 流断裂"。旧日志无 endReason 时退回 notice 与 interrupted */}
            <Show when={!isLiveTurn() && turnEndNote(t())}>
                <div class="text-body text-warning" data-turn-end-note>
                    ⚠ {turnEndNote(t())}
                </div>
            </Show>
            {/* 降级轮的行内标注（##424 刀 2）：这一轮是从 turns 折出来的文本记录，
                锚点指向的 ops 已经不在了 ⇒ 如实说「原始记录已清理」，不静默空白。 */}
            <Show when={degradedOf(t())?.refDangling}>
                <div class="text-body text-warning/80" data-turn-degraded={degradedOf(t())?.state ?? ""}>
                    ⓘ {DEGRADED_DANGLING_TEXT}
                </div>
            </Show>
            {/* 轮尾：**时刻靠左、纯文本、不可点**（滚屏阅读时左侧最容易误触，那句话也没有可点的东西），
                用量按钮靠右（hover 出汇总卡、点击开明细抽屉）—— 两个状态都存页面级：
                块树每帧重建，组件内 signal 会被清掉（D3 的"点开又自动合上"）。

                直播轮次**一出现助理内容就出这行**（`usagePending`）：main 的 usage patch 要等
                第一步 finish-step 才写，而第一个思考可能长跑几十秒 —— 那段时间轮尾什么都没有，
                这行会"啪"地蹦出来把下面的内容顶开（用户 2026-10-11 口径：第一次动态内容时
                时间和 token 那行就该在）。数字还没到时给占位（见 TurnUsageBar 的 pending）。 */}
            <Show when={t().attrs.usage || usagePending()}>
                <TurnUsageBar
                    turnId={t().id}
                    usage={t().attrs.usage}
                    pending={usagePending()}
                    /* 直播中：状态图标走"进行中"、⚡速度才显示（停下即不显示 —— 静默的旧轮没有"当前速度"） */
                    live={isLiveTurn()}
                    /* 结束原因：状态行那个 ✓/✗/⛔ 的判据（##288 的 endReason；旧日志 null → 不给图标） */
                    end={endReasonOf(t())}
                    /* 本轮统计（步数 · 耗时 · ⚙ n · 💭 n · ❌ n）画在**轮尾**：时刻右边、
                       用量左边（用户 2026-10-11 口径，判据见 turnStatLine） */
                    stat={turnStatLine(t(), counts())}
                    hover={props.usageHover?.id === t().id}
                    onHover={(el) => props.onHoverUsage(t().id, el)}
                    onHoverEnd={props.onHoverEndUsage}
                    onDetail={() => props.onDetailUsage(t().id)}
                />
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
// 默认留言排到下一步（马上生效，##360）；右侧那个开关可切回下一轮排队，也可再次切回来。
//
// 顺序：队列是 FIFO 且**顺序即投递顺序**，所以拖拽改的是真实的投递次序（不是显示偏好），
// 松手即落盘（`steer.reorder` 提交完整顺序）。拖拽只认手柄：整行可拖会让"想选中那句话"
// 变成"拖走了它"，而手柄是明确的意图声明（与任务树整行可拖不同 —— 那里一行只有一个含义）。

/**
 * 「别人说的话」行（##377 第 16 刀 / ##166 §43.3 B）—— **只读回显**。
 *
 * 它是一条 room `reply` 事件（非主人格）在任务页时间线里的投影：**不是本任务会话的块**
 * —— 正文与进度都仍住在那位成员的会话里，这里只有 `ref{memberUri, turnId}` 这条**引用**
 * （§32.3 护栏：不把块流拷进 room 事件流）。展开 L2 时才按需读那一轮（`room.turn`），
 * 渲染走**任务对话同一套**（`ChatView` + `TurnView`，§28.7 A：不许另写一套）。
 */
/** 空 pin 表：外部行不参与「过程 bar 开合」的页面级偏好（那份偏好键的是本会话的块 id） */
const EMPTY_PIN: Record<string, boolean> = {};

/** 投递状态徽章的配色（与侧边栏 `statusClass` 同一套语义色，不另造） */
function deliveryBadgeClass(s: string): string {
    return s === "ok"
        ? "badge-success"
        : s === "failed"
          ? "badge-error"
          : s === "running"
            ? "badge-info"
            : s === "queued"
              ? "badge-warning"
              : "badge-ghost";
}

/**
 * room 里「**我说的话**」（##377 第 17 刀 / ##166 §44.2 B）—— 指那些**没投给主人格**的发言
 * （`@dev 帮我看看`）。它们不在任何本任务会话里 ⇒ ops 流里没有 ⇒ 只能由 room 事件流画。
 *
 * 形态与本人今天在任务页的气泡一致（右对齐、无署名 —— 说话人就是页面操作者本人），
 * 下面挂**投递状态**：谁在排队 / 谁收到了 / 谁没投出去。
 * `routing:'note'`（`@` 自己）按**中性**标记（不是故障 —— §38.2），
 * 打错名则走 `deliveries[].error` + 那条空 reply 的红字（判据 8：不许被"笔记"吞掉）。
 */
/**
 * 「忙时插话」那条 say 指到的那一轮（##377 第 29 刀 · body 真缺陷第 1 条）。
 *
 * 忙时插话的回复**属于正在跑的那一轮**（`deliveryPlanFor` 的 `steer` 分支），room 里于是只有
 * `say`、没有 `reply` —— 用户从前只能看见「已投递（插进本轮）」那个徽章，**看不出回复在哪**，
 * 容易以为这句话没回。这里把它指到那一轮：地址不是另存的映射，而是投递状态里的 `turnId`
 * （读侧由 `steerId` + 落盘块的 `meta.steerId` 反查得到）。
 *
 * 展开态**由页面持有**（与 `RoomReplyRow` 同一个理由：虚拟化摘行会卸载组件）。
 */
function RoomSteerTurn(props: {
    roomId: string;
    memberId: string;
    memberLabel: string;
    turnId: string;
    open: boolean;
    onToggle: () => void;
}) {
    const [st, setSt] = createSignal<{ turn: BlockNode | null; turnId: string; live: boolean } | null>(null);
    const [err, setErr] = createSignal<string | null>(null);
    /** 取过一次就不再重复取（与 reply 行同一口径：要刷新进度就收开一次） */
    let fetched = false;
    const load = async (): Promise<void> => {
        try {
            // 字面寻址（成员, 轮次）：这条 say 没有 reply 事件可借 `ref`（回复属于那一轮，不属它）
            const r = await diyService.diy.room.turn({
                id: props.roomId,
                event: undefined,
                member: props.memberId,
                turn: props.turnId,
            });
            setSt({ turn: r.turn as BlockNode | null, turnId: r.turnId, live: r.live });
            setErr(null);
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
    };
    createEffect(() => {
        if (props.open && !fetched) {
            fetched = true;
            void load();
        }
    });
    return (
        <div
            class="w-[92%] rounded-lg border border-base-300 bg-base-100/60"
            data-room-say-turn={props.turnId}
        >
            <button
                class="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-caption"
                onClick={() => props.onToggle()}
                data-room-say-turn-toggle={props.turnId}
                title="这条被插进了正在跑的那一轮：回复属于那一轮，不单独成条"
            >
                <span class="opacity-60">{props.open ? "▾" : "▸"}</span>
                <span>回复在 {props.memberLabel} 那一轮</span>
                <span class="opacity-50" data-room-say-turnid>
                    {props.turnId}
                </span>
                <Show when={st()?.live}>
                    <span class="badge badge-xs badge-info">直播中</span>
                </Show>
            </button>
            <Show when={props.open}>
                <div class="px-2 pb-1.5">
                    <Show when={err()}>
                        <div class="text-caption text-error">{err()}</div>
                    </Show>
                    <Show when={!st() && !err()}>
                        <div class="text-caption opacity-60">正在取这一轮…</div>
                    </Show>
                    <Show when={st()?.turn}>
                        {(t) => <RoomTurnBody turn={t()} turnId={st()!.turnId} live={st()?.live === true} />}
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function RoomSayRow(props: {
    event: RoomEvent;
    room: Room | null;
    roomId: string;
    /** 展开态（页面级，key = `<sayId>:<memberId>`） */
    openOf: (key: string) => boolean;
    onToggleTurn: (key: string) => void;
}) {
    const deliveries = () => props.event.deliveries ?? [];
    /** 能指到某一轮的投递（忙时插话那条；`skipped` / 未落位的不在里面） */
    const turnRefs = () => steerTurnRefs(props.event);
    return (
        <div class="flex flex-col items-end gap-0.5" data-room-say={props.event.id}>
            <div class="max-w-[92%] rounded-lg bg-primary/15 px-3 py-1.5 text-prose whitespace-pre-wrap">
                {props.event.text || <span class="opacity-50">（无正文）</span>}
            </div>
            <Show when={props.event.routing === "note"}>
                <div class="flex items-center gap-1" data-room-say-note={props.event.id}>
                    <span class="badge badge-xs badge-ghost opacity-70">笔记</span>
                    <span class="text-caption opacity-40">不投递，只进房间历史</span>
                </div>
            </Show>
            <Show when={deliveries().length > 0}>
                <div class="flex flex-wrap justify-end gap-1">
                    <For each={deliveries()}>
                        {(d) => (
                            <span
                                class={`badge badge-xs ${deliveryBadgeClass(d.status)}`}
                                title={d.error ?? d.note ?? ""}
                                data-room-say-delivery={`${props.event.id}:${d.memberId}`}
                                data-room-say-status={d.status}
                            >
                                {memberName(props.room, d.memberId)} · {deliveryStateText(d)}
                            </span>
                        )}
                    </For>
                </div>
            </Show>
            {/* 回复归属（##377 第 29 刀）：忙时插话没有属于自己的回复，但它被哪一轮消化了是可查的 */}
            <Show when={turnRefs().length > 0}>
                <div class="flex w-full flex-col items-end gap-0.5" data-room-say-turns={props.event.id}>
                    <For each={turnRefs()}>
                        {(r) => {
                            const key = `${props.event.id}:${r.memberId}`;
                            return (
                                <RoomSteerTurn
                                    roomId={props.roomId}
                                    memberId={r.memberId}
                                    memberLabel={memberName(props.room, r.memberId)}
                                    turnId={r.turnId}
                                    open={props.openOf(key)}
                                    onToggle={() => props.onToggleTurn(key)}
                                />
                            );
                        }}
                    </For>
                </div>
            </Show>
        </div>
    );
}

/**
 * 一轮的块渲染（`reply` 行与「忙时插话指到那一轮」共用 —— 同一份 `ChatView`/`TurnView`，不复制）。
 *
 * 抽出来的理由（##377 第 29 刀）：同一条 room 里现在有两个入口要看"某一轮"——
 * reply 行的过程进度、以及被插话那条 say 的「回复属于哪一轮」。两份各自写一遍
 * ⇒ 下次改渲染参数必漏一处（第 27 刀 `collectTurn`/`settleTurn` 的同一条教训）。
 */
function RoomTurnBody(props: { turn: BlockNode; turnId: string; live: boolean }) {
    return (
        <ChatView source={{ trees: () => [props.turn], live: () => props.live }}>
            <TurnView
                turnId={props.turnId}
                pin={EMPTY_PIN}
                level={2}
                histOpen={true}
                onCycle={() => undefined}
                conclusionLines={3}
                onResizeLines={() => undefined}
                onToggle={() => undefined}
                onFull={() => undefined}
                liveTurnId={props.live ? props.turnId : null}
                md={true}
                usageHover={null}
                onHoverUsage={() => undefined}
                onHoverEndUsage={() => undefined}
                usageDetail={null}
                onDetailUsage={() => undefined}
            />
        </ChatView>
    );
}

function RoomReplyRow(props: {
    event: RoomEvent;
    room: Room | null;
    roomId: string;
    /**
     * 展开态**由页面持有**（受控）：虚拟化会把滚出视口的行从 DOM 摘掉 ⇒ 组件卸载 ⇒
     * 组件内的 `open` 会丢（实测：展开后滚出去再滚回来，进度又收起来了）。
     * 与本会话轮次的 `pin` / `histOpen` 同一个理由、同一种做法。
     */
    open: boolean;
    onToggle: () => void;
}) {
    const [st, setSt] = createSignal<{ turn: BlockNode | null; turnId: string; live: boolean } | null>(
        null,
    );
    const [err, setErr] = createSignal<string | null>(null);
    /** 取过一次就不再重复取（展开/收起是纯前端两态；要刷新进度就再收开一次） */
    let fetched = false;

    const load = async (): Promise<void> => {
        const e = props.event;
        if (!e.ref || !props.roomId) return;
        try {
            const r = await diyService.diy.room.turn({
                id: props.roomId,
                event: e.id,
                member: undefined,
                turn: undefined,
            });
            setSt({ turn: r.turn as BlockNode | null, turnId: r.turnId, live: r.live });
            setErr(null);
        } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
        }
    };
    // 首次展开时取那一轮（之后复用；要刷新进度就收开一次）
    createEffect(() => {
        if (props.open && !fetched) {
            fetched = true;
            void load();
        }
    });

    const author = () => props.event.author;
    /** 头像位次取房间展示序（与成员栏同一份 ⇒ 同一人两处头像一致） */
    const avatarIdx = (): number => {
        const i = orderedMembers(props.room).findIndex((m) => m.id === author());
        return i >= 0 ? i : 0;
    };

    return (
        <div class="flex flex-col gap-0.5" data-room-reply={props.event.id}>
            {/* 署名行（与任务页的 user 署名同一形状：色点 + 名字 + 时刻）—— 别人的话一律左对齐 */}
            <div class="flex items-center gap-1.5 text-caption">
                <span class="text-base leading-none">{memberAvatar({ id: author() }, avatarIdx())}</span>
                <span class="font-bold" style={{ color: memberColor({ id: author() }) }}>
                    {memberName(props.room, author())}
                </span>
                <span class="opacity-50" title={props.event.ts}>
                    {fmtClock(props.event.ts)}
                </span>
                <span class="opacity-40">→ 我</span>
                <Show when={props.event.sourceTask}>
                    <span class="opacity-40" data-room-reply-source>
                        来自会话 {props.event.sourceTask}
                    </span>
                </Show>
            </div>
            <div class="rounded-lg bg-base-200 px-3 py-1.5 text-prose whitespace-pre-wrap">
                {props.event.text || <span class="opacity-50">（无正文）</span>}
            </div>
            {/* 未投递要**明确报错**（##166 §44.2 D 判据 8）：`@` 打错名走的就是这条路 ——
                room-service 为"不可投递的收件人"记一条空 reply + error，不许静默留白 */}
            <Show when={props.event.error}>
                <div class="text-caption text-error" data-room-reply-error={props.event.id}>
                    未投递：{props.event.error}
                </div>
            </Show>
            <Show when={props.event.ref}>
                <div
                    class="rounded-lg border border-base-300 bg-base-100/60"
                    data-room-reply-progress={props.event.id}
                >
                    <button
                        class="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-caption"
                        onClick={() => props.onToggle()}
                        data-room-reply-toggle={props.event.id}
                    >
                        <span class="opacity-60">{props.open ? "▾" : "▸"}</span>
                        <span>过程进度</span>
                        <span class="opacity-50" data-room-reply-turnid>
                            {props.event.ref?.turnId}
                        </span>
                        <Show when={st()?.live}>
                            <span class="badge badge-xs badge-info">直播中</span>
                        </Show>
                    </button>
                    <Show when={props.open}>
                        <div class="px-2 pb-1.5">
                            <Show when={err()}>
                                <div class="text-caption text-error">{err()}</div>
                            </Show>
                            <Show when={!st() && !err()}>
                                <div class="text-caption opacity-60">正在取这一轮…</div>
                            </Show>
                            <Show when={st()?.turn}>
                                {(t) => (
                                    <RoomTurnBody turn={t()} turnId={st()!.turnId} live={st()?.live === true} />
                                )}
                            </Show>
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function SteerBar(props: {
    items: SteerItem[];
    onCancel: (id: string) => void;
    onToggleMode: (id: string) => void;
    onReorder: (ids: string[]) => void;
    /** 「修改」：把某条撤回编辑器（队列里移除 + 内容回到输入框） */
    onEdit: (id: string) => void;
    /** 「立即发送」：整批现在送出去（不等下一轮/下一步） */
    onFlush: () => void;
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
                    {/* 头部一行：条数 + 「立即投递」。没有它时队列只能"等时机"——
                        空闲入队的留言曾因此永远躺着（##303）；入口必须显式存在，别指望用户去猜结果。
                        ⚠️ 文案刻意不含「发送」二字：输入区的「发送」按钮也在这棵 a11y 树里，
                        含同样的词会让"按文本点按钮"的定位（人读与自动化）两边都变模糊。 */}
                    <div class="mb-1 flex items-center justify-between gap-2">
                        <span class="opacity-60">待投递 {props.items.length} 条</span>
                        <button
                            class="btn btn-outline btn-xs"
                            data-steer-flush
                            aria-label="立即投递队列里的全部留言"
                            data-tip="立即投递：有轮次在跑 → 全部加急到下一步；空闲 → 立刻作为新一轮发出"
                            onClick={() => props.onFlush()}
                        >
                            立即投递
                        </button>
                    </div>
                    <ul class="max-h-24 space-y-0.5 overflow-y-auto">
                        <For each={props.items}>
                            {(it) => (
                                <SteerRow
                                    item={it}
                                    onCancel={props.onCancel}
                                    onToggleMode={props.onToggleMode}
                                    onEdit={props.onEdit}
                                />
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
    onEdit: (id: string) => void;
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
                  · 下一轮：时钟 + 弱色 = "还得等"
                  · 下一步（默认，加急）：闪电 + warning 高对比底色/描边 + 呼吸 = "马上插进去"
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
            {/* 修改：撤回编辑器（队列里移除 + 内容回到输入框）。
                与「取消」的区别是**话不丢**：取消是放弃这句话，修改是"我再改改"。 */}
            <button
                class="btn btn-ghost btn-xs shrink-0"
                aria-label="修改这条插话（撤回编辑器）"
                data-tip="撤回编辑器再改（输入框已有内容时接在 --- 之后）"
                data-steer-edit={it().id}
                onClick={() => props.onEdit(it().id)}
            >
                ✎
            </button>
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

/**
 * 工具输出的**最大化**视图（过程内容框右上角那枚放大按钮点开）。
 *
 * 双态是「最大化 ⇄ 恢复」：框上是 `IconExpand`（最大化），进来后这里是 `IconCompress`
 * （恢复）—— 与 ViewGrid 的 area chrome 同一套 swap 语汇，不另立一套。关闭的三条路
 * （恢复按钮 / Esc / 点遮罩）等价：`onClose` 都回原处，全屏只是**看完即走**的临时层。
 */
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
            notificationStore.addToast(
                "success",
                "已复制到剪贴板",
                copyOkMeta({ what: "全屏面板内容", text: props.content, mech: "LocalChatPage.tsx::FullscreenModal" }),
            );
        } catch (e) {
            // 用户主动触发的动作：失败必须告知，不能假装成功
            console.error("[localChat] 剪贴板写入失败：", e);
            notificationStore.addToast(
                "error",
                "复制失败（剪贴板不可用）",
                copyFailMeta({ what: "全屏面板内容", mech: "LocalChatPage.tsx::FullscreenModal", error: e }),
            );
        }
    };
    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-2"
            data-fullscreen-modal
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            {/* 真·全屏（`w-full h-full max-w-none`）：名字叫"最大化"，就该铺满内容区 ——
                原来 `max-w-4xl` 只占 90% 宽、下面留白，看长输出反而更挤。 */}
            <div class="bg-base-100 rounded-lg w-full h-full max-w-none flex flex-col">
                <div class="flex items-center gap-2 px-4 py-2 border-b shrink-0">
                    <span class="font-mono text-body truncate flex-1">{props.title}</span>
                    <button class="btn btn-ghost btn-xs" onClick={copy}>
                        复制
                    </button>
                    <button
                        class="btn btn-ghost btn-xs px-1"
                        data-fullscreen-restore
                        data-tip="恢复（退出最大化）"
                        aria-label="恢复尺寸"
                        onClick={() => props.onClose()}
                    >
                        <IconCompress class="h-4 w-4" />
                    </button>
                </div>
                <pre class="overflow-auto p-4 text-body font-mono whitespace-pre-wrap break-all flex-1">
                    {props.content}
                </pre>
            </div>
        </div>
    );
}

/**
 * 虚拟行壳（##301）：一行 = 一个绝对定位的盒子，顶边由**高度账**给出。
 *
 * 为什么绝对定位而不是 `space-y-*` + 上下 spacer：spacer 与相邻行的间距要单独推一遍账，
 * 边界（首行 / 末行 / spacer 自己）极易差一个 gap；绝对定位下"每行顶边 = 前缀和"是恒等式。
 *
 * 尺寸观察登记（`ro`）挂在这里而不是页面级 ref：**卸载时要反注册** —— RO 强引用目标元素，
 * 不反注册就是"每滚过一行泄漏一个 DOM 元素"（长会话滚动会累积成灾）。onMount/onCleanup
 * 天然成对。
 */
function VirtRow(props: {
    rowKey: string;
    /** 该行顶边（px，账面前缀和） */
    top: number;
    ro: ResizeObserver;
    register: (el: Element, key: string) => void;
    children: JSX.Element;
}) {
    let el: HTMLDivElement | undefined;
    onMount(() => {
        if (el) props.ro.observe(el);
    });
    onCleanup(() => {
        if (el) props.ro.unobserve(el);
    });
    return (
        <div
            ref={(e) => {
                el = e;
                if (e) props.register(e, props.rowKey);
            }}
            class="absolute inset-x-0"
            style={{ top: `${props.top}px` }}
        >
            {props.children}
        </div>
    );
}

// ─── 页面 ───────────────────────────────────────────

export function LocalChatPage(props: {
    uri?: string;
    /**
     * 给了它 = 本会话区负责「右栏（成员栏）默认开合」（##166 §44.1 ②，值 = pageId）。
     *
     * 为什么落在这里（而不是右栏那个 view 里）：**右栏收起时 `ViewGrid` 根本不挂载它**
     * （`groups()` 按 `plan().visibleAreaIds` 过滤）⇒ 由被收起者自己"发现自己该展开"是死结。
     * 而本组件（中心会话区）恒挂载、且成员表本来就在它手里（`loadRoomFeed`）。
     */
    rosterAutoFor?: string;
}) {
    // 执行页显式传入 uri；不能依赖全局 selectedUri，否则任务详情还在异步加载时，
    // 页面可能显示“选择任务”但聊天仍沿用上一个任务的会话，形成串台。
    const uri = () => props.uri ?? taskStore.selectedUri ?? null;
    /**
     * 转后台（##408 刀 21）：进入本任务会话就开始盯「哪条前台调用能转」，离开即停。
     *
     * `Cmd/Ctrl+B` = 把本任务在跑的前台命令**全部**转后台（opencode 的同款快捷键）。
     * 只在焦点不在输入框时生效 —— 在输入框里按 Cmd+B 是编辑器的"加粗"，不该被抢。
     */
    createEffect(
        on(uri, (u) => {
            if (u) detachablesStore.watch(u);
            else detachablesStore.stop();
        }),
    );
    onCleanup(() => detachablesStore.stop());
    onMount(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "b") return;
            const el = e.target as HTMLElement | null;
            const tag = el?.tagName?.toLowerCase();
            if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
            const ids = detachablesStore.all();
            if (ids.length === 0) return; // 没有可转的就不抢默认行为（浏览器/系统可能有自己的 Cmd+B）
            e.preventDefault();
            // 一条一条转（各自有各自的拒绝理由；一把 Promise.all 会把失败原因糊成一团）
            void (async () => {
                for (const id of ids) {
                    const msg = await detachablesStore.detach(id);
                    setDetachNote({ ...detachNote(), [id]: msg });
                }
            })();
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });
    /**
     * 本任务当前状态（##400 静态提示用）：树节点优先，详情面板兜底。
     * 只做**显示**用途 —— 拒绝的真判据在 main（TurnGate）；前端的只读只是把"按了也没用"藏起来。
     */
    const taskState = createMemo<string | null>(() => {
        const u = uri();
        if (!u) return null;
        const walk = (ns: readonly { uri?: string; state?: string; children?: readonly unknown[] }[]): string | null => {
            for (const n of ns) {
                if (n.uri === u && n.state) return n.state;
                const hit = walk((n.children ?? []) as typeof ns) as string | null;
                if (hit) return hit;
            }
            return null;
        };
        const fromTree = walk(taskStore.nodes);
        if (fromTree) return fromTree;
        const sel = taskStore.selectedTask;
        return sel && sel.uri === u ? (sel.state ?? null) : null;
    });
    /** 终态（结案 / 取消 / 归档）⇒ 输入区只读 + 一条静态提示（##391 三问齐全） */
    const closedInfo = createMemo(() => {
        const u = uri();
        const s = taskState();
        if (!u || !isTerminalSessionState(s)) return null;
        return {
            reason: TERMINAL_STATE_REASON[s],
            detail: terminalSessionDetail(u, s),
        };
    });
    /** 静态提示的 ##391 二级信息（来源 / 原因 / 机制）—— 与拒绝回执是**同一件事**的两种呈现面 */
    const closedMeta = createMemo(() => {
        const c = closedInfo();
        const s = taskState();
        if (!c) return null;
        return {
            source: "任务状态 · 会话输入区（LocalChatPage.tsx / shared/turn-gate.ts）",
            reason: `${c.reason}（当前状态 ${s ?? "?"}），本会话不再接受新的轮次`,
            detail: [
                "在监测什么：任务的 state 字段（done 结案 / cancelled 取消 / closed 归档）。三者是终态，会话不再开新轮次。",
                "为什么只读：拒绝发生在服务端 —— main 的开轮准入（TurnGate，local-agent.chat 最开头）会在解析模型、自动压缩之前就返回，不建轮次、不落盘、不发请求。输入框只读只是省得你白打一句话，不是判据。",
                "历史与队列：已发生的对话照常可翻阅；队列里的留言不会丢，任务恢复可续后仍会投递。",
                `怎么续：${c.detail}`,
                "含义：这不是故障，是任务生命周期（终态）的预期行为。",
            ].join("\n"),
        };
    });
    const [inputValue, setInputValue] = createSignal("");
    /** 「⋯」溢出菜单：低频/危险操作（清空历史）默认不显示，点开才露出（VSCode 附加菜单式） */
    const [moreOpen, setMoreOpen] = createSignal(false);
    /** 压缩历史（事件快照列表）；压缩参数改在「窗口构成页」第一 tab（M1），卡内可快捷直压 */
    const [gensOpen, setGensOpen] = createSignal(false);
    const [personaPanelOpen, setPersonaPanelOpen] = createSignal(false);
    const [fullscreen, setFullscreen] = createSignal(false);
    let scrollRef: HTMLDivElement | undefined;
    /** 页面容器（用于量 view 高度：输入区封顶 = view 1/3，见 R5 输入框高度） */
    let rootRef: HTMLDivElement | undefined;
    /** 当前 view 高度（px，0 = 尚未量到）；输入区 max-height 由它推出 */
    const [viewH, setViewH] = createSignal(0);
    /** 输入区封顶高度（口径见 lib/layout-metrics 的 chatInputMaxHeight） */
    const inputMaxH = () => chatInputMaxHeight(viewH());
    /** 跟随态：true=贴底（新内容自动滚到底）；false=用户正在上方阅读（绝不打扰） */
    const [stick, setStick] = createSignal(true);
    /** 恢复中闸门：历史重放期间 trees 连发，须让位给 restore 的定位（否则被抢先滚到底） */
    let restoring = false;
    /** 当前会话的运行态轮询停止函数（切会话/卸载时调用） */
    let unwatch: (() => void) | null = null;

    // ─── 视口虚拟化（##301）：只挂视口附近的轮，未渲染轮走**实测高度账** ─────────────
    // 为什么不沿用 `content-visibility: auto`：它只跳过「离屏子树的布局与绘制」，**DOM 仍是全量**
    // （一次 48 轮会话实测 1441 个节点全体在树里），堆随会话长度无界 —— 本任务要把远端轮真从
    // DOM 摘掉（判据与几何见 lib/chat-virtual 头注）。
    /** 滚动容器当前 scrollTop（窗口计算的输入） */
    const [scrollTop, setScrollTop] = createSignal(0);
    /** 滚动容器可视高度（首帧未量到 = 0 ⇒ 只挂 overscan 那一段） */
    const [chatVpH, setChatVpH] = createSignal(0);
    /** 高度账的版本号：账一变就 ++，让布局 memo 重算（账本身不是信号） */
    const [ledgerTick, setLedgerTick] = createSignal(0);
    /** 视口外上下各多挂一段：滚动时下一屏的行已就位，不至于滚一下闪一下 */
    const OVERSCAN_PX = 600;
    /** 高度账**按 taskUri** 存：切走再切回来（组件不卸载）仍复用实测高度，省一次重新测量 */
    const ledgers = new Map<string, HeightLedger>();
    const curLedger = createMemo(() => {
        const u = uri() ?? "";
        let l = ledgers.get(u);
        if (!l) {
            l = new HeightLedger();
            ledgers.set(u, l);
        }
        return l;
    });
    const touchLedger = () => setLedgerTick((v) => v + 1);
    /** 被观察的行元素 → 行键（RO 回调只拿得到元素） */
    const rowKeyOf = new WeakMap<Element, string>();
    const registerRow = (el: Element, key: string) => rowKeyOf.set(el, key);

    /**
     * 落地一批实测高度（**唯一**写账入口）。
     *
     * 这里**只写账**，不碰 scrollTop —— 位置由「视口锚定」统一负责（见下面那个监听 layout 的
     * effect）。为什么必须收口到一处：**任何**能让行顶边变化的因（测量修正、前插补段、清空重置）
     * 都得按同一基准补偿，散在两处（旧实现是 applyHeights 一处、loadOlderInto 一处）就会
     * 重复补偿 —— 实测症状是一次上滚把视口多推 605px（补偿量算了两遍）。
     */
    const applyHeights = (list: Array<[string, number]>) => {
        const led = curLedger();
        const ks = rowKeys();
        const live = new Set(ks);
        const tailKey = ks[ks.length - 1];
        let changed = false;
        let changedAboveTail = false;
        for (const [k, h] of list) {
            if (!(h > 0) || !live.has(k) || led.get(k) === h) continue;
            changed = true;
            // 末行自身长高/变矮 = "内容从屏幕下方自然长出"，**不该**把视口拽回去（与 ##331
            // followPlan 同一口径）。只有**非末行**的高度修正才会把底部内容整体顶走。
            if (k !== tailKey) changedAboveTail = true;
        }
        if (!changed) return;
        for (const [k, h] of list) if (h > 0 && live.has(k)) led.set(k, h);
        touchLedger();
        // 贴底时非末行变化 ⇒ 补偿回底部（不然内容跳）。非贴底的补偿归上面的「视口锚定」effect。
        const el = scrollRef;
        if (el && stick() && changedAboveTail) writeScrollTop(el, el.scrollHeight);
    };

    /** 行尺寸观察（一个 RO 观察窗口内所有行；卸载的行由 VirtRow 的 onCleanup 反注册） */
    const rowRO = new ResizeObserver((entries) => {
        const list: Array<[string, number]> = [];
        for (const e of entries) {
            const k = rowKeyOf.get(e.target);
            if (k) list.push([k, (e.target as HTMLElement).offsetHeight]);
        }
        if (list.length > 0) applyHeights(list);
    });

    /**
     * 视口锚点：**滚动位置锚在「块」上，不锚在像素上**（##301；类型与决策见 lib/chat-scroll）。
     *
     * 行顶边 = 账面高度前缀和 ⇒ 账一变（测量修正 / 前插补段 / 重置）所有行的绝对位置都变，
     * 而 scrollTop 是像素量、不会自己跟着走。锚定 = 记下「视口顶那一块 + 它相对视口顶的偏移」，
     * 布局一变就把它放回原处 —— 这是"上滚补段 / 上方行被测量"不跳的唯一保证。
     *
     * ⚠️ 锚点必须在**布局变化之前**捕获：`captureAnchor` 挂在滚动事件上（滚动不改布局，
     * 那一刻读到的就是"变之前的"锚）。若改成在布局变化后现取，取的已是插了新内容的**新**布局
     * —— 锚点落到新内容第一块、偏移变 0，补偿直接归零（实测：上滚补段交替出现"补了 / 没补"）。
     */
    let vpAnchor: ChatAnchor | null = null;

    /** 取当前视口锚点（视口顶那一块 + 块内偏移）—— 定义在 lib/chat-scroll 的 `pickAnchorIn` */
    const captureAnchor = (el: HTMLElement) => {
        vpAnchor = pickAnchorIn(el);
    };

    /**
     * 我们自己写 scrollTop 的**唯一出口**（程序化滚动）。
     *
     * 为什么要收口：虚拟窗口（`win`）吃的是 `scrollTop` **信号**，不是元素的 `el.scrollTop`。
     * 只写元素 ⇒ 窗口还按旧位置挂行 —— 补偿后"锚点行"根本不在 DOM，`applyAnchor` 找不到它，
     * 连校几帧空转后放弃（实测症状：上滚补段后锚点那一轮被新内容顶出窗口）。
     * 故：写元素 + 同步信号（窗口当场重挂）+ 记下写入值，让紧随其后的 scroll 事件**别重取锚点**
     * （那是我们自己的滚动，不是用户的；照取会用旧窗口的 DOM 重新锚到别的块，丢掉用户正读的那一块）。
     */
    let progWriteTop: number | null = null;
    const writeScrollTop = (el: HTMLDivElement, v: number) => {
        el.scrollTop = clampScrollTop(v, el.scrollHeight, el.clientHeight);
        progWriteTop = el.scrollTop; // 浏览器可能自行收口，以**实际**值为准
        setScrollTop(el.scrollTop);
        return el.scrollTop;
    };

    /**
     * 块 id → 它所属**行**在账面布局里的下标（虚拟化下定位用：块自己可能还没上屏）。
     *
     * 行 = 块树的根级项；`layout().keys` 与 `localChatStore.trees` 同序同长，故先找含该块的
     * 根项、再在 keys 里定位。只在恢复阅读位置 / 布局补偿时调用（O(块数) 一次，可接受）。
     */
    const anchorRowIndex = (blockId: string): number => {
        for (const t of localChatStore.trees) {
            if (t.id === blockId || containsBlockId(t, blockId)) return layout().keys.indexOf(t.id);
        }
        // ⚠️ **合成行键**（##377 第 15 刀）：过程 bar 那类"行"的 `data-block-id` 是
        // `<首叶 id>_bar`（见 ProcBar），它**不是块 id** ⇒ 上面那条 `containsBlockId` 找不到，
        // 锚点被判失效（实测 `ri=-1`）。而锚点正是 `pickAnchorIn` 从 `[data-block-id]` 里挑的
        // ⇒ **只要视口顶落在过程 bar 上，阅读位置就永远恢复不了**（症状：切走再切回看不见最新轮）。
        // 行粒度就是轮（`layout().keys` = 轮 id），故按轮前缀落位。
        for (const t of localChatStore.trees) {
            if (blockId.startsWith(`${t.id}_`)) return layout().keys.indexOf(t.id);
        }
        return -1;
    };

    /** 滚到底并置跟随态。
     *  ##301：虚拟化下总高随「测量」增长（未渲染轮先是估算），一次设值到不了底 ——
     *  迭代几帧直到贴底位置稳定（每帧都会把新进窗口的行量进账，总高随之收敛）。 */
    const gotoBottom = () => {
        const el = scrollRef;
        if (!el) return;
        setStick(true);
        // ⚠️ **收敛判据要看高度，不能只看 scrollTop**（##377 第 15 刀实测）：
        // 原判据是"连续 3 帧 scrollTop 不变"，而内容（长 Markdown / 实测高度回填）**在之后
        // 才撑高** —— 位置短暂稳定就收敛，等高度涨上来时人已不在底部（实测：reload 后
        // `st=3136` 而底在 `~7000`，视口停在第 2 轮，**最新轮根本不在窗口里**）。
        // 故改成"位置**与**高度都稳定"才收敛，并把上限放宽到 ≈1.5s（30 帧 = 500ms 不够长回答用）。
        let left = 90;
        let prev = -1;
        let prevH = -1;
        let stable = 0;
        const tick = () => {
            // ⚠️ 每一帧都要重读跟随态：用户（或测试）在这期间上滚了 ⇒ 立刻让位。
            // 少了这一条，本循环会把他的滚动**反复拽回底部** —— 实测表现为随机的
            // "滚到顶后又弹回底部"（谁抢到就在谁那一侧）。
            if (!stick()) return;
            const at = writeScrollTop(el, el.scrollHeight);
            const h = el.scrollHeight;
            stable = at === prev && h === prevH ? stable + 1 : 0;
            prev = at;
            prevH = h;
            if (left-- > 0 && stable < 3) requestAnimationFrame(tick);
        };
        tick();
    };

    /**
     * 补一段更早的历史（任务 293 / ##301）。**两个入口共用**：滚到顶部附近的 `onScroll`，
     * 以及顶部提示条被点（后者不依赖"容器可滚"，见提示条处的注释）。
     *
     * 位置补偿**不在这里**：虚拟化后"前插了内容"只是让账面顶边整体下移，纠正它的是
     * 上面那个**视口锚定** effect（行集合一变就重跑）。这里只管取历史 —— 补偿只此一处，
     * 免得两套机制各推一次（旧实现正是如此，实测一次上滚多推 605px）。
     */
    const loadOlderInto = () => {
        if (!localChatStore.hasOlder || localChatStore.olderLoading) return;
        const u = uri();
        if (!u) return;
        void localChatStore.loadOlder(u);
    };

    /**
     * 滚到顶部附近 ⇒ 补一段更早的历史（任务 293）。
     *
     * ⚠️ 滚动**不是唯一**入口（也**不能**是）：若首载窗口的渲染高度 ≤ 视口，"滚到顶"
     * 这个前提根本不成立（用户滚不出 scroll 事件），补段就永远不发生、提示条一直挂着。
     * 所以提示条本身是个可点的按钮，走同一份 `loadOlderInto`。
     */
    const maybeLoadOlder = (el: HTMLDivElement) => {
        if (el.scrollTop > TOP_TRIGGER_PX) return;
        loadOlderInto();
    };

    /**
     * 按锚点定位（##331 ③）：先设一次，再**连校几帧**（同 `loadOlderInto` 的 tick 写法）。
     *
     * 为什么要连校：锚点块上屏那一刻高度还没稳定（`content-visibility:auto` 的估算高度换实测值
     * 会把下方内容整体推走），一次赋值只能落进"当时的坐标系"。
     * 校正只做两件事：锚点没归位就推回去；**用户在滚**（scrollTop 不再是我们设的值）就收手跟人。
     * 硬上限 ≈ 24 帧（400ms），且连续 3 帧不漂即收 —— 不会无限跑。
     */
    const applyAnchor = (el: HTMLDivElement, a: ChatAnchor) => {
        const first = blockElOf(el, a.id);
        if (first) {
            const target = anchorScrollTop(blockTopIn(el, first), a.offset, el.scrollHeight, el.clientHeight);
            // 已经对齐就不写（##377 第 19 刀）：写入本身不带副作用，但"每 2.5s 校正一次"会
            // 让布局/窗口来回重挂，用户看得见闪 —— 无事不发生才是稳。
            if (Math.abs(target - el.scrollTop) < 1) return;
            writeScrollTop(el, target);
        }
        // 逐帧决策全在 `anchorTick`（纯函数，review1 R1 的 latch 在那）：组件只负责量 DOM 与写 scrollTop。
        let st: AnchorTickState = { lastSt: el.scrollTop, quiet: 0, userLeft: false };
        // 起始基准取**写后**的实际值：上面那次定位可能被浏览器收口（内容变矮），
        // 若基准仍记着"想写的值"，第一帧就被误判成"用户在滚"而 latch 收手（R1 的反面）。
        let left = 24; // 硬上限 ≈24 帧（400ms）：估算高度回填 + Markdown 撑高都在这个尺度内收敛
        const tick = () => {
            const n = blockElOf(el, a.id);
            const r = anchorTick(
                {
                    scrollTop: el.scrollTop,
                    blockOffset: n ? n.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
                    offset: a.offset,
                    scrollHeight: el.scrollHeight,
                    clientHeight: el.clientHeight,
                    quietFrames: 3,
                },
                st,
            );
            st = r.state;
            if (r.setTop !== null) {
                writeScrollTop(el, r.setTop);
                st.lastSt = el.scrollTop; // 写后以**实际值**为准（浏览器可能自行收口，避免下一帧误判成"用户在滚"）
            }
            if (r.stop || left-- <= 0) return;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    /** 恢复某会话阅读位置：有锚点 → 按**块身份**回到那一行并按位置校准跟随态；
     *  无记录（新会话 / 没读过）→ 直接看最新，而不是停在顶部。 */
    const restore = (u: string) => {
        restoring = true;
        // 上一个会话的末叶子 id 在这里失去意义：不清掉的话，本会话内容上屏那帧会被判成
        // "新块出现"而跟着它滚（`restoring` 闸门只挡到 rAF 之前）
        prevTailId = null;
        void localChatStore
            .open(u)
            .catch(() => undefined)
            .then(() => {
                const a = localChatStore.getScroll(u);
                requestAnimationFrame(() => {
                    restoring = false;
                    const el = scrollRef;
                    if (!el) return;
                    if (a) {
                        // ##301：虚拟化下锚点块**可能还没进窗口**（窗口由 scrollTop 决定）——
                        // 先按锚点所在**行**的账面顶把窗口挪过去，再按块身份精修（`applyAnchor`
                        // 自带连校；块上屏那一刻即收敛）。
                        //
                        // ⚠️ 必须把 `vpAnchor` 一并设为恢复值：程序化滚动被 `writeScrollTop` 记了
                        // 下来（紧随的 scroll 事件不再重取锚点），若此处不设，锚点就一直是 null ——
                        // 之后测量回填（估算 → 实测）让行顶整体位移时，已无锚可依，视口静静漂走
                        // （实测症状：切回后视口顶部落到**下一轮**上，偏出一整轮）。
                        vpAnchor = a;
                        const ri = anchorRowIndex(a.id);
                        // 走 `writeScrollTop`：同步窗口信号，锚点行**这一帧就上屏**，
                        // 后面的 `applyAnchor` 才找得到它（只写元素的话窗口还按旧位置挂行）。
                        if (ri >= 0) {
                            writeScrollTop(el, layout().tops[ri]!);
                            applyAnchor(el, a);
                            setStick(nearBottom(el)); // 上次停在底部 → 继续跟随；否则尊重阅读位置
                        } else {
                            // ⚠️ **锚点行不在账面布局里**（##377 第 15 刀）：锚点块既不在窗口里、
                            // 也算不出它属于哪一行 ⇒ 什么都不做的话视口就留在**顶部**（新挂载的
                            // 容器 scrollTop = 0），而窗口 `[0,4)` 根本不含最新轮 ——
                            // 用户看到的正是"切走再切回就看不见 agent 刚说的话"。
                            // 退化为**看最新**（与"无锚点"同一条路）：宁可丢一次阅读位置，
                            // 也不能把用户扔回一段与刚才无关的历史。
                            console.warn(
                                `[localChat] 阅读位置锚点已失效（块 ${a.id} 不在账面布局里），改为看最新`,
                            );
                            gotoBottom();
                        }
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
                // 检索面板在最上层：先关它，别顺手把别的浮层一起关了（##389）。
                // **不影响 ⌘F**：查找条有它自己的 Esc（FindBar 的输入框 keydown），两者互不代劳。
                if (chatFindStore.open) {
                    chatFindStore.close();
                    clearHitHighlight();
                    return;
                }
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
        // 数据层检索（##389）：面板只负责"找"，"跳"必须由会话页做（滚动容器/块树/虚拟窗口都在这）。
        // view 高度跟随窗口/布局变化（输入区封顶 = view 1/3，R5）
        const ro = new ResizeObserver(() => setViewH(rootRef?.clientHeight ?? 0));
        if (rootRef) ro.observe(rootRef);
        setViewH(rootRef?.clientHeight ?? 0);
        // ##301：滚动容器高度 = 虚拟化的视口高度；容器尺寸变（窗口缩放 / 面板开合）要重算窗口
        const cro = new ResizeObserver(() => {
            setChatVpH(scrollRef?.clientHeight ?? 0);
            setScrollTop(scrollRef?.scrollTop ?? 0);
        });
        if (scrollRef) cro.observe(scrollRef);
        setChatVpH(scrollRef?.clientHeight ?? 0);
        onCleanup(() => {
            ro.disconnect();
            cro.disconnect();
            rowRO.disconnect(); // 组件卸载：RO 不 disconnect 会攥着整个窗口的行元素
            document.removeEventListener("click", closePopovers);
            chatFindStore.release(ownerUri);
            clearHitHighlight();
            document.removeEventListener("keydown", onKey, true);
        });
        const u = uri();
        if (u) {
            restore(u);
            applyDraft(u);
        }
    });
    // 组件卸载前：**保存阅读位置** + 防抖中的草稿落盘 + 停掉运行态轮询。
    //
    // ⚠️ 阅读位置的**保存点在卸载**，不在 `on(uri)` effect（##331 ③ 的真根因）：
    //   本页每个任务一个实例（`TaskRunPage` 给的是**固定** `props.uri`），切 tab = 本实例卸载 +
    //   另一个实例挂载 —— `uri` 这个信号对单个实例**永远不变**，挂在它上面的保存代码一次都不会跑，
    //   于是 `getScroll` 读到的永远是空，每次切回都退化成"看最新"（实测切回顶部从第 8 轮变第 18 轮）。
    //   卸载时 DOM 还在（cleanup 先于节点移除），几何读得到。
    onCleanup(() => {
        unwatch?.();
        unwatch = null;
        const u = uri();
        if (u) {
            if (scrollRef) localChatStore.setScroll(u, pickAnchorIn(scrollRef));
            void draftStore.flushNow(u);
        }
    });
    // 直播中的尾轮 turn id：中断警告 / 等待态 gating 用。
    // 判据是 main 真值（localChatStore.live），不是本地 running —— 别人（CLI/另一窗口）
    // 正在跑的轮次同样是"直播中"，否则那一轮的未收 stop 会被显示成"流中断/崩溃恢复"。
    const liveTurnId = () => {
        if (!localChatStore.live) return null;
        // 判据（"最后一个未收尾的**真实**轮次"，机器回执轮不算）在 chat-fold.liveTurnOf：
        // ⚠️ 收口在那儿之前，这里自己数"最后一个 turn"会被**排队回执轮**顶掉 —— 它排在直播轮
        // 之后、且立刻 stop，于是 liveTurnId 判 null、真正在跑的那轮不再算"直播中"，
        // 它的未收 stop 就被渲染成「⚠ 本轮未完成（流中断/崩溃恢复）」（用户 2026-10-17 实测假警报）。
        return liveTurnOf(localChatStore.trees)?.id ?? null;
    };
    /**
     * ⌀ 底部汇总行的速度 = **全局平均**（总均档，tok/s）。
     *
     * 口径（##349，用户 2026-10-15）：「页面最下汇总行显示**总平均**速度，避免与上方重复同一数字」
     * —— 上方轮尾那枚是"本轮"（⚡实时 / ⌀轮均），这里是"全部轮次"的 Σ总输出 ÷ Σ响应耗时。
     * 数据源 = 逐步账本镜像（`localChatStore.usage`），随每步刷新；没有步 → null → 整块不画。
     */
    const overallRate = () => sessionAvgRate();
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
     *      点一下就是"合上/打开"（语义见 `historyOpenOf`）。
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
    /** 这一轮的**过程历史**开不开（语义见 historyOpenOf：没动过就完全跟全局） */
    const histOpenOf = (turnId: string): boolean => historyOpenOf(foldMarks()[turnId], globalLevel());
    /** 人物标题 bar：**收拢 / 展开这一轮的历史**（不换层）——按"现在是什么态"决定翻到哪一边。
     *  注意：**1 级下也能直接开历史**（不是"先切到 3 级"）—— 用户 2026-10-12 R22 口径。 */
    const toggleTurn = (turnId: string) =>
        setFoldMarks((p) => ({ ...p, [turnId]: histOpenOf(turnId) }));
    /** 全部轮次换层（顶部按钮）：**状态复位**，不是"叠加一层"。
     *
     * 用户 2026-10-11 口径：「总的 4 级展开按钮点击后，所有级别都应该复原，而不是因为被点开
     * 或收缩过，导致切换到 4 级时还有手工点过的某些行没铺开」——两种手工痕迹一起清：
     * 轮次的收拢标记（`foldMarks`）与每行的开合 pin（`pinned`）。
     * 不清 pin 的话，切到 4 级时"某一行还闭着"（`rowOpen` 的 pin 优先），看着就是按钮失灵。 */
    const cycleAllLevels = () => {
        setGlobalLevel(cycleTurnLevel(globalLevel()));
        setFoldMarks({});
        setPinned({});
    };
    /** 1 级摘要的行数 */
    /** 1 级摘要可视行数（全局偏好，落盘）—— 结论下缘拖拽改它（见 TextRow.startResize） */
    const [conclusionLines, setConclusionLines] = createSignal(Caches.diy_chat_conclusion_lines.get());
    const changeConclusionLines = (n: number) => {
        const v = Math.min(CONCLUSION_LINES_MAX, Math.max(CONCLUSION_LINES_MIN, Math.round(n)));
        setConclusionLines(v);
        Caches.diy_chat_conclusion_lines.set(v);
    };
    /** 清空确认：清空会删掉 main 侧 ops/llm 日志（rmSync，不可恢复），必须二次确认 */
    const [confirmClear, setConfirmClear] = createSignal(false);
    /**
     * 发送前门禁（##426 B）的状态：`null` = 没在问（**未超限时永远是 null** —— 不弹、不闪、不改文案）。
     * 存的是「原文 + 量出来的三个数」：用户在框里选动作时，原文必须一字不动（它还没发出去）。
     */
    const [inputGateAsk, setInputGateAsk] = createSignal<{ text: string; gate: InputGate } | null>(null);
    const [gateBusy, setGateBusy] = createSignal(false);
    const [pinned, setPinned] = createSignal<Record<string, boolean>>({});
    /** `force` 显式定值（活动块这类**默认展开**的行：缺省翻转出来是 true = 维持展开） */
    const togglePin = (id: string, force?: boolean) =>
        setPinned((p) => ({ ...p, [id]: force ?? !p[id] }));
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
    // ─── room：本任务的时间线第二源（##377 第 16/17 刀 / ##166 §43.3 B · §44.2 B）──────
    // 任务页的时间线 = **本任务 ops 流**（主人格，逐字不变）+ room 事件流里
    // **ops 流没有的那部分**。谁归谁**只由一条判据定**（`shared/room.opsOwnsEvent`，纯函数有单测）：
    //   · `say` 投给了主人格 ⇒ ops 里有 user 块 ⇒ room 跳过；`@dev` ⇒ 不在任何本任务会话里 ⇒ room 画；
    //   · `reply` 来自主人格 ⇒ 就是它自己那一轮 ⇒ room 跳过；别人回的 ⇒ room 画。
    // 三条边界（§32.3）：
    //   · **不拷块流**：这里只拿 `ref{memberUri, turnId}` 定位，L2 展开时才按需读那一轮
    //     （`room.turn`），数据始终只住在那位成员的会话里；
    //   · **只读**：room 侧不写任何东西（发送走 `localChatStore.sendViaRoom` 的投递口）；
    //   · **写侧只剩一处**：`submit` 走 room.post（第 17 刀），room 事件流里那部分由本层渲染。
    const [roomMeta, setRoomMeta] = createSignal<Room | null>(null);
    /** room 事件流里**该由本页画**的那些（say + reply，已按 opsOwnsEvent 过滤） */
    const [roomFeed, setRoomFeed] = createSignal<RoomEvent[]>([]);
    /** room 侧读失败：只影响「别人说的话」这一层，**不动**本会话的错误位（会话本身是好的） */
    const [roomNote, setRoomNote] = createSignal<string | null>(null);

    /** 主人格 member id：以房间成员表为准（缺则退回契约常量 —— 正常房间恒有它） */
    const mainMemberId = (room: Room | null): string =>
        room?.members.find((m) => m.main === true)?.id ?? MAIN_MEMBER_ID;

    /**
     * 右栏（成员栏）的**默认开合**（##166 §44.1 ②）：除主人格外还有 agent 成员 ⇒ 默认展开；
     * 只有主人格（人成员不计）⇒ 默认收起
     * （单人任务因此与改动前逐字一致 —— §43.3 C 判据 7 的原意）。
     *
     * 两条边界：
     *   · **用户表过态就彻底停手**（`layoutStore.userTouched`：点过开合按钮 / 拖过线都算）；
     *   · **每次进任务都按当前任务重算**（布局是**页级**的，所有任务 tab 共享一份 —— 只设一次的话
     *     "打开过多人任务"会把单人任务的右栏也顶出来）。故走 `setAreaHiddenAuto`（不置 userTouched）。
     */
    const applyRosterAuto = (room: Room | null): void => {
        const page = props.rosterAutoFor;
        if (!page || !room || layoutStore.userTouched(page)) return;
        // ⚠️「成员 > 1」= 除主人格之外**还有 agent 成员** —— **人成员不计**（否则单人任务
        // = 人 + 主人格 = 2 条也会展开，判据 7「单人任务逐字不变」当场破；实测踩过）。
        const otherAgents = room.members.filter((m) => m.kind === "agent" && m.main !== true).length;
        layoutStore.setAreaHiddenAuto(page, "right", otherAgents === 0);
    };

    /**
     * 软轮询的**引用稳定器**（##377 第 19 刀）：内容没变就不换引用。
     *
     * 为什么必须做：`roomFeed` 每 2.5s 换一次引用 ⇒ `roomRows → allRows → rowKeys → layout`
     * 整条 memo 链重算 ⇒ 下游**视口锚定 effect** 被惊动 ⇒ 视口被甩到账面顶再校正回来。
     * 实测（用户报的「任务会话时不时跳到某处」）：有 room 行的任务，视口每 2.5s 从
     * 用户位置弹到 +1885px 再弹回；把 room 事件清空后 13 秒纹丝不动 ⇒ 因果坐实。
     */
    const feedSig = (es: RoomEvent[]): string =>
        es.map((e) =>
            // `turnId` 也进签名（##377 第 29 刀）：它是**读侧投影**，投递当下没有、队列项落位后才算得出来 ——
            // 不进签名的话轮询永远认作"没变"，那条 say 的「回复在那一轮」入口就不会出现。
            `${e.id}:${(e.deliveries ?? []).map((d) => `${d.memberId}=${d.status}=${d.turnId ?? ""}`).join(",")}:${e.error ?? ""}`,
        ).join("|");
    const roomSig = (r: Room | null): string =>
        r === null ? "none" : `${r.focus ?? ""}#${r.members.map((m) => `${m.id}:${m.name}:${m.main === true ? "main" : ""}`).join(",")}`;
    let prevFeedSig: string | null = null;
    let prevRoomSig: string | null = null;

    const loadRoomFeed = async (u: string, soft = false): Promise<void> => {
        try {
            const r = await diyService.diy.room.get({ id: u, limit: 200 });
            const rs = roomSig(r.room);
            if (rs !== prevRoomSig) {
                prevRoomSig = rs;
                setRoomMeta(r.room);
                applyRosterAuto(r.room);
            }
            const mid = mainMemberId(r.room);
            const shown = r.events.filter((e) => !opsOwnsEvent(e, mid));
            const fs = feedSig(shown);
            if (fs !== prevFeedSig) {
                prevFeedSig = fs;
                setRoomFeed(shown);
            }
            if (!soft) setRoomNote(null);
        } catch (e) {
            if (!soft) setRoomNote(`读房间失败：${e instanceof Error ? e.message : String(e)}`);
        }
    };

    /** 输入框补全源（**memo 稳引用**：`memberCompletion` 每次调用返回新函数，见 MdEditor 的 prop 注释） */
    const chatCompletions = createMemo(() => [
        memberCompletion(() => roomMeta()?.members ?? []),
        taskCompletion,
    ]);

    /**
     * 外部行（key = `room:<事件 id>`）—— **按 id 复用行对象**：`<For>` 按引用 diff，
     * 轮询每 2.5s 给一批新事件对象，不复用就会把外部行每轮重建（展开态跟着丢）。
     * `tsMs` 取事件的 ISO 时刻（同一事件不变 ⇒ 复用安全）。
     */
    let prevRoomRows: { key: string; tag: string; tsMs: number }[] = [];
    const roomRows = createMemo(() => {
        const byKey = new Map(prevRoomRows.map((r) => [r.key, r]));
        prevRoomRows = roomFeed()
            .map(
                (e) =>
                    byKey.get(`room:${e.id}`) ??
                    { key: `room:${e.id}`, tag: e.kind === "say" ? "room-say" : "room-reply", tsMs: Date.parse(e.ts) },
            )
            .filter((r) => Number.isFinite(r.tsMs))
            .sort((a, b) => a.tsMs - b.tsMs);
        return prevRoomRows;
    });

    const roomEventOf = (key: string): RoomEvent | null =>
        roomFeed().find((e) => `room:${e.id}` === key) ?? null;

    /** 外部行的展开态（**页面级**：虚拟化摘行会卸载组件，放组件里会丢 —— 见 RoomReplyRow 头注） */
    const [replyOpen, setReplyOpen] = createSignal<Record<string, boolean>>({});
    /** 「忙时插话 → 那一轮」的展开态（key = `<sayId>:<memberId>`；与 reply 行同一条理由） */
    const [steerOpen, setSteerOpen] = createSignal<Record<string, boolean>>({});

    // 取数：首挂 + 切任务 + 2.5s 轻量轮询（与侧边栏同一节奏；本切片无推送通道）
    onMount(() => {
        const u0 = uri();
        if (u0) void loadRoomFeed(u0);
        const t = setInterval(() => {
            const u = uri();
            if (u) void loadRoomFeed(u, true);
        }, 2500);
        onCleanup(() => clearInterval(t));
    });
    createEffect(
        on(uri, (u) => {
            if (u) void loadRoomFeed(u);
        }),
    );

    let prevRows: { key: string; tag: string }[] = [];
    const rootRows = createMemo(() => {
        const byKey = new Map(prevRows.map((r) => [r.key, r]));
        prevRows = localChatStore.trees.map((t) => {
            const old = byKey.get(t.id);
            return old && old.tag === t.tag ? old : { key: t.id, tag: t.tag };
        });
        return prevRows;
    });
    // ─── 视口虚拟化的布局（##301）：行键 → 账面高度 → 前缀和 → 视口窗口 ────────────
    /**
     * **合并行清单**（##377 第 16 刀）：本任务块树行（`rootRows`，对象按 id 复用、逐字不变）
     * + room 的「别人说的话」行。没有外部行时**原样返回** `rootRows()` —— 单人任务因此
     * 走的是与改动前**同一条**路径（判据 7）。
     *
     * 归位依据：本任务轮的**起始时刻** = turnId 内嵌毫秒（`t<ms>`，与 `userStamp` 同源），
     * 与 reply 事件的 `ts` 比大小 ⇒ 插在「最后一个起始时刻 ≤ reply.ts」的轮**之后**。
     * 不一律堆到末尾 —— 历史 reply 要与它发生时刻对应的那一轮相邻（口径「按 ts 归位」）。
     */
    const allRows = createMemo(() => {
        const base = rootRows();
        const reps = roomRows();
        if (reps.length === 0) return base;
        const out: { key: string; tag: string }[] = [];
        let i = 0;
        for (const r of base) {
            if (r.tag === "turn") {
                const t0 = Number(r.key.slice(1));
                while (i < reps.length && reps[i]!.tsMs <= t0) out.push(reps[i++]!);
            }
            out.push(r);
        }
        while (i < reps.length) out.push(reps[i++]!);
        return out;
    });
    /**
     * 行键序列 + **引用稳定器**（##377 第 19 刀）：`allRows()` 在有 room 行时每次返回新数组，
     * 若这里无条件新建 keys 数组，`layout` 就会跟着每 2.5s 重算一次（假布局变化），
     * 把视口锚定 effect 惊动 —— 用户看到"时不时跳到某处"。内容不变 ⇒ 复用同一数组引用。
     */
    let prevKeysRef: string[] = [];
    const rowKeys = createMemo(() => {
        const ks = allRows().map((r) => r.key);
        if (ks.length === prevKeysRef.length && ks.every((k, i) => k === prevKeysRef[i])) return prevKeysRef;
        prevKeysRef = ks;
        return ks;
    });
    /**
     * 前缀和布局。`heights` 与 `keys` 同长；未渲染过的行走**估算**（见 HeightLedger）。
     * 账不是信号，故显式依赖 `ledgerTick`（写账处 `touchLedger()`）。
     */
    const layout = createMemo(() => {
        void ledgerTick();
        const led = curLedger();
        const ks = rowKeys();
        led.retain(ks); // 会话被清空/重置后，旧轮的高度别继续拖均值
        const heights = ks.map((k) => led.get(k));
        return { keys: ks, heights, ...stackRows(heights) };
    });
    /** 视口窗口 [from, to)（含 overscan）—— DOM 里只该有这一段 */
    const win = createMemo(() => {
        const L = layout();
        return windowRange(L.tops, L.heights, scrollTop(), chatVpH(), OVERSCAN_PX);
    });
    /** 窗口内的行对象（仍是合并清单里按 id 复用的那份 ⇒ `<For>` 不重建未变的行） */
    const windowRows = createMemo(() => {
        const [f, t] = win();
        return allRows().slice(f, t);
    });
    /** 已挂 DOM 的轮 id（探针要判「命中落在未渲染的轮上」，见 chatFindStore.probeDeep） */
    const renderedTurnIds = createMemo(() => {
        const out = new Set<string>();
        for (const r of windowRows()) if (r.tag === "turn") out.add(r.key);
        return out;
    });

    // ─── 数据层检索的定位（##389）──────────────────────────────────────────────
    // 三条路（判据 = 目标轮在不在块树里 / 在不在窗口里）：
    //   ① 在树、只在窗口外 → 纯滚动（`scrollToTurn`，不碰数据）；
    //   ② 不在树（早于最老段）→ `localChatStore.jumpTo` 段跳取一段回来，再走 ①；
    //   ③ 正在流式 → **不抢滚动**：记下目标，等这一轮收尾（`view.live` 下降沿）再定位。
    // 到位后：目标轮高亮 800ms + 该轮内的命中字用 Highlight API 点亮（都不改 DOM、不改 store 数据）。
    let pendingLocate: { turnId: string; hit: ChatFindHit } | null = null;
    /** 定位闭环的"手"柄：用户一滚就收手（别和目标轮较劲） */
    let locateLatch = 0;
    /**
     * 定位闭环上一拍**我们自己写的** scrollTop —— 跟它比对就知道这一拍是不是人滚的
     * （`progWriteTop` 是同一思路：区分"谁写的滚动"）。`null` = 闭环没在跑。
     */
    let locateOwnTop: number | null = null;

    const flashTurn = (turnId: string) => {
        const el = scrollRef;
        if (!el) return;
        const node = el.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
        if (!node) return;
        node.setAttribute("data-hit-flash", "1");
        paintHitHighlight(node, chatFindStore.query);
        window.setTimeout(() => {
            // 用户可能已经滚走/该轮已被虚拟化摘掉：属性留在离屏节点上无害，故不做存在性判断
            node.removeAttribute("data-hit-flash");
        }, 800);
    };

    /**
     * 滚到某一轮（**闭环校正**，与 `applyAnchor` 同一手法）：
     * 先按账面顶边把窗口挪过去（`writeScrollTop` 会同步窗口信号 ⇒ 那一轮这一帧就上屏），
     * 再量真实位置、把偏差补掉，两三帧内收敛（未实测行的高度估算会在这儿被实测值替换）。
     * 硬上限 12 帧（200ms）：收敛不了也不再拉扯（估算高度抖动的极端情形），宁可差几像素。
     *
     * **用户接管即收手**（R1）：每一拍拿 `locateOwnTop`（上一拍我们写的位置）与当前 `scrollTop`
     * 比对 —— 对不上就是人滚了（滚轮 / 拖条 / 触控板），当场作废闭环，**不再把人拽回去、也不闪**。
     * 唯一豁免：内容变矮时浏览器把 `scrollTop` **收口**到新的 max（那不是人滚的），否则
     * 「定位到靠近末尾的轮」会被自己的布局变化取消掉。
     */
    const scrollToTurn = (turnId: string) => {
        const el = scrollRef;
        if (!el) return;
        setStick(false); // 定位到历史 = 用户要看的那一轮，别让"贴底跟随"再把视口拽走
        const token = ++locateLatch;
        locateOwnTop = el.scrollTop; // 起点：第一拍之前（~16ms 内）人滚了也要能认出来
        let stable = 0;
        let left = 12;
        const tick = () => {
            if (token !== locateLatch) return; // 又点了一次结果 / 用户手动接管
            // 用户接管：这一拍的位置不是我们上一拍写的那儿 ⇒ 收手（判据见函数头注）
            const own = locateOwnTop;
            if (own !== null && Math.abs(el.scrollTop - own) > 1.5) {
                const max = el.scrollHeight - el.clientHeight;
                const clamped = el.scrollTop < own && el.scrollTop >= max - 1;
                if (!clamped) {
                    locateLatch++;
                    return;
                }
            }
            const L = layout();
            const ri = L.keys.indexOf(turnId);
            if (ri < 0) return; // 这一轮已不在树里（日志被改写）⇒ 放弃，不猜位置
            const node = el.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
            if (node) {
                // 目标轮顶离容器顶 8px：轮首的用户气泡整条可见，且明确"这一轮从这儿开始"
                const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
                const d = top - 8;
                if (Math.abs(d) > 1) writeScrollTop(el, el.scrollTop + d);
                stable = Math.abs(d) <= 1 ? stable + 1 : 0;
            } else {
                // 还没上屏：按账面顶边把它挪进窗口（下一帧它就有 DOM 了）
                writeScrollTop(el, L.tops[ri] ?? 0);
                stable = 0;
            }
            if (stable >= 2 || left-- <= 0) {
                flashTurn(turnId);
                return;
            }
            locateOwnTop = el.scrollTop; // 下一拍拿它判「是不是人滚了」
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    const locateHit = (hit: ChatFindHit) => {
        const u = uri();
        if (!u) return;
        clearHitHighlight();
        // ③ 流式中：先稳态（口径 4）—— 此刻抢滚动会和"跟随新内容"互相拉扯
        if (localChatStore.view.live) {
            pendingLocate = { turnId: hit.turnId, hit };
            notificationStore.addToast(
                "info",
                "这一轮正在生成：结束后自动定位到命中处",
                chatNotice(
                    "检索定位 · locateHit（##389）",
                    `命中处落在本轮 ${hit.turnId} 尚未写完的内容里；此刻抢滚动会与「跟随新内容」互相拉扯 → 已记下命中位置，轮结束后自动滚过去`,
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        void (async () => {
            const inTree = localChatStore.trees.some((t) => t.id === hit.turnId);
            if (!inTree) {
                const ok = await localChatStore.jumpTo(u, hit.at);
                if (!ok) {
                    notificationStore.addToast(
                        "error",
                        "定位失败：会话日志已被改写（这一轮的字节位置不再有效），请重新检索",
                        chatNotice(
                            "检索定位 · jumpTo（##389）",
                            `命中记录的轮 ${hit.turnId} 在盘上的字节位置 ${hit.at} 已失效（日志被改写/清空）→ 视图**未移动**（不会跳到错的地方）；重新检索可拿到新位置`,
                            DETAIL_CHAT_FIND,
                        ),
                    );
                    return;
                }
            }
            scrollToTurn(hit.turnId);
        })();
    };

    // ─── 作业来源定位（##408 刀 6）────────────────────────────────────────────
    // 用户从「作业」面板点「来源」⇒ 这里把视口送到那次 tool_call 块并高亮。
    // 与检索定位（##389）**同一套手法**（`anchorRowIndex` + 闭环校正 + 用户接管即收手），
    // 差别只在终点粒度：检索要跳的是「这一轮的命中字」，作业要跳的是「这一轮里的某一个块」。
    let pendingBlockLocate: ChatNavTarget | null = null;

    /** 高亮一个块（沿用 `data-hit-flash`：轮级高亮与块级高亮同一条通道，样式在 index.css） */
    const flashBlock = (blockId: string) => {
        const el = scrollRef;
        if (!el) return;
        const node = blockElOf(el, blockId);
        if (!node) return;
        node.setAttribute("data-hit-flash", "1");
        window.setTimeout(() => node.removeAttribute("data-hit-flash"), 1600);
    };

    /**
     * 滚到**某一块**（不是某一轮）：闭环校正的靶子是块顶，行索引用 `anchorRowIndex(blockId)`
     * —— 它返回的是**包含该块的那一轮**的行号，故"轮还没上屏"时仍能按账面顶边把窗口挪过去。
     * 用户接管即收手（与 `scrollToTurn` 同一判据，含「内容变矮被浏览器收口」的豁免）。
     */
    const scrollToBlock = (turnId: string, blockId: string) => {
        const el = scrollRef;
        if (!el) return;
        setStick(false); // 定位到历史 = 用户要看的那一处，别让"贴底跟随"再把视口拽走
        const token = ++locateLatch;
        locateOwnTop = el.scrollTop;
        let stable = 0;
        let left = 12;
        const tick = () => {
            if (token !== locateLatch) return;
            const own = locateOwnTop;
            if (own !== null && Math.abs(el.scrollTop - own) > 1.5) {
                const max = el.scrollHeight - el.clientHeight;
                const clamped = el.scrollTop < own && el.scrollTop >= max - 1;
                if (!clamped) {
                    locateLatch++;
                    return;
                }
            }
            const L = layout();
            const ri = anchorRowIndex(blockId);
            const rowIdx = ri >= 0 ? ri : L.keys.indexOf(turnId);
            if (rowIdx < 0) return; // 这一轮已不在树里（日志被改写）⇒ 放弃，不猜位置
            const node = blockElOf(el, blockId);
            if (node) {
                // 块顶留 32px：过程行的行头（时间 / 工具名）整条可见——"从这儿开始"要看得见主语
                const top = blockTopIn(el, node) - el.scrollTop;
                const d = top - 32;
                if (Math.abs(d) > 1) writeScrollTop(el, el.scrollTop + d);
                stable = Math.abs(d) <= 1 ? stable + 1 : 0;
            } else {
                writeScrollTop(el, L.tops[rowIdx] ?? 0);
                stable = 0;
            }
            if (stable >= 2 || left-- <= 0) {
                flashBlock(blockId);
                return;
            }
            locateOwnTop = el.scrollTop;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    /**
     * 定位到作业的来源块。
     *
     * 三级降级（与 job-run 的硬约束 2 一致：origin 是**引用**，点开时去读那边真源）：
     *   ① 这一轮在块树里 → 滚过去 + 高亮该块；
     *   ② 正在流式 → 记下，轮末再跳（此刻抢滚动会与"跟随新内容"打架）；
     *   ③ 不在块树（历史被压缩 / 未加载 / 日志已轮转）→ **视图不动**，如实说"原文不可用"，
     *      并指向作业面板里的落盘输出。绝不跳到一个"看起来像"的位置（那是假导航）。
     */
    /**
     * 拿插话队列项 id 反查块（##436）：留言投递时块还没生成，只有 `steerId` 是当时就有的锚点。
     *
     * 判据：块树的 `attrs.steerId`（`local-agent.steerBlockOps` 落盘时就带上，见
     * `shared/room.RoomDelivery.steerId`）；找不到 = 那一轮还没跑 / 历史被压缩。
     */
    const steerAnchorOf = (steerId: string): { turnId: string; blockId: string } | null => {
        const walk = (n: BlockNode): BlockNode | null => {
            if (n.attrs["steerId"] === steerId) return n;
            for (const c of n.children) {
                const hit = walk(c);
                if (hit) return hit;
            }
            return null;
        };
        for (const tr of localChatStore.trees) {
            const hit = walk(tr);
            if (hit) return { turnId: tr.id, blockId: hit.id };
        }
        return null;
    };

    const locateJobTarget = (t: ChatNavTarget) => {
        clearHitHighlight();
        // steer 锚点先翻译成 轮/块 —— 之后**只有一条**定位路径（不另写一套滚动/展开逻辑）
        const resolved = t.turnId && t.blockId ? { turnId: t.turnId, blockId: t.blockId } : t.steerId ? steerAnchorOf(t.steerId) : null;
        const fromInbox = t.origin === "inbox";
        if (localChatStore.view.live) {
            pendingBlockLocate = t;
            notificationStore.addToast(
                "info",
                resolved ? `这一轮正在生成：结束后自动定位到${fromInbox ? "那条留言" : "那次工具调用"}` : "这一轮正在生成：结束后再看你的留言",
                chatNotice(
                    fromInbox ? "通知信箱 · 去来源会话（##436）" : "作业来源 · locateJobTarget（##408）",
                    resolved
                        ? `锚点落在本轮 ${resolved.turnId} 仍在写入的内容里 → 已记下，轮结束后再滚过去（流式中抢滚动会与跟随打架）`
                        : "这一轮还在跑，块还没落盘 ⇒ 此刻定位不到；轮末自动再试一次（原文在信箱面板里，随时可读）",
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        if (!resolved) {
            // 说清楚"为什么没定位"——body 硬要求：不许只开 tab 还不说
            notificationStore.addToast(
                "info",
                fromInbox ? "已打开会话；这条留言还没有轮次锚点（可能尚未被投递）" : "原文已不可用：这一轮不在当前窗口",
                chatNotice(
                    fromInbox ? "通知信箱 · 去来源会话（##436）" : "作业来源 · locateJobTarget（##408）",
                    fromInbox
                        ? `留言锚点（steerId=${t.steerId ?? "无"}）在已加载的块树里找不到 —— 它插进的那一轮可能还没跑，或历史被压缩。` +
                          "**视图未移动**；原文请回信箱面板读（那里存了未截断的留言）。"
                        : `锚点 轮 ${t.turnId ?? "?"} / 块 ${t.blockId ?? "?"} 不在已加载的块树里（压缩历史或日志轮转）⇒ 视图**未移动**；` +
                          "作业面板里的 settle 输出与 logs/<runId>.log 才是这次的原文",
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        const inTree = localChatStore.trees.some((tr) => tr.id === resolved.turnId || containsBlockId(tr, resolved.blockId));
        if (!inTree) {
            notificationStore.addToast(
                "info",
                "原文已不可用：这一轮不在当前窗口（历史被压缩或未加载）→ 输出请看作业详情",
                chatNotice(
                    "作业来源 · locateJobTarget（##408）",
                    `锚点 轮 ${t.turnId} / 块 ${t.blockId} 不在已加载的块树里（压缩历史或日志轮转）⇒ 视图**未移动**；` +
                        `作业面板里的 settle 输出与 logs/<runId>.log 才是这次的原文`,
                    DETAIL_CHAT_FIND,
                ),
            );
            return;
        }
        revealBlock(resolved.turnId, resolved.blockId);
        scrollToBlock(resolved.turnId, resolved.blockId);
    };

    /**
     * 让目标块**真的进 DOM**（否则滚动没靶子，高亮也无处可画）。
     *
     * 两道门（默认 3 级下都可能挡着）：
     *   ① 过程历史整段关着（1-2 级，或用户收拢了这轮）⇒ 只把**这一轮**的历史打开；
     *   ② 目标块在某个「过程 bar」里（3 级下 bar 是折叠的）⇒ pin 开**那一段**
     *      （键 `row:<段首叶子 id>`，与组件里 `rowOpen` 同一口径）。
     * 都不动全局级别 —— 为了看一条工具调用把整页铺成 4 级，会把用户正在读的地方全改掉。
     */
    const revealBlock = (turnId: string, blockId: string) => {
        const turn = localChatStore.trees.find((tr) => tr.id === turnId || containsBlockId(tr, blockId));
        if (!turn) return;
        if (!histOpenOf(turnId)) setFoldMarks((p) => ({ ...p, [turnId]: false }));
        for (const row of turnRows(turn, null)) {
            if (row.kind !== "proc") continue;
            if (!row.parts.some((n) => n.id === blockId)) continue;
            setPinned((p) => ({ ...p, [`row:${row.key}`]: true }));
            break;
        }
    };

    /**
     * 消费「作业面板 / 通知信箱发来的待定位请求」（同一条通道，`chatNavStore`）。
     *
     * 为什么放在会话页而不是面板里：只有这里拿得到滚动容器与块树（与 `chatFindStore.claim` 同一理由）。
     * 三个条件（等任务切过来 + 等会话数据到位 + 等块树非空）都是必需的：
     * 面板点「来源」时先 `openTaskRun` 切页，本页**可能整页新挂**，那一刻 trees 还是空的。
     */
    createEffect(() => {
        const target = chatNavStore.pending;
        if (!target) return;
        const u = uri();
        if (!u || u !== target.taskUri) return;
        if (localChatStore.currentUri !== u) return;
        if (localChatStore.trees.length === 0) return;
        const taken = chatNavStore.take(u);
        if (taken) locateJobTarget(taken);
    });

    /** 流式收尾后补做待定的定位（只做一次：轮末下降沿是"现在可以抢滚动"的唯一时机） */
    createEffect(
        on(
            () => localChatStore.view.live,
            (live) => {
                if (live) return;
                if (pendingLocate) {
                    const p = pendingLocate;
                    pendingLocate = null;
                    locateHit(p.hit);
                    return;
                }
                if (pendingBlockLocate) {
                    const b = pendingBlockLocate;
                    pendingBlockLocate = null;
                    locateJobTarget(b);
                }
            },
        ),
    );

    // 面板归属哪个任务：跟着 uri 走（首挂时 uri 可能还没到，故不能只靠 onMount 那一次）。
    // `ownerUri` 记下**本页认领过的**那个 uri：卸载时按它交还（不能拿卸载那一刻的 uri() 去比
    // —— 那时 props 可能已被上层置空，会比不上，于是"永不清空"或者"错清别人"）。
    let ownerUri: string | null = null;
    createEffect(
        on(uri, (u) => {
            ownerUri = u;
            chatFindStore.claim(u, locateHit);
        }),
    );

    // 桥接探针（口径 1）：页内查找 0/0 时对数据层探一次，让 FindBar 能说出「本会话另有 N 处」。
    // 只在「页内没找到**且**查询非空」时探 —— 页内找到了就没必要再扫一遍数据层。
    createEffect(() => {
        const q = findStore.query;
        const n = findStore.count;
        const open = findStore.open;
        const u = uri();
        // ⚠️ **untrack**：`renderedTurnIds()` 依赖虚拟窗口，直接读会让"每滚一帧就整份重扫"
        // （74MB 会话 = 滚动时主进程反复从头读文件，且边滚边重扫永远探不出结论）。
        // 「其中几处未渲染」只是**探针那一刻**的快照 —— 它是一句提示，不必逐帧精确。
        const rendered = untrack(renderedTurnIds);
        if (!open || !u || !q.trim() || n > 0) {
            chatFindStore.clearProbe();
            return;
        }
        chatFindStore.probeDeep(u, q, rendered, chatFindStore.scopes);
    });

    /** 被摘出行列之外的行：保留实测高度（不清），滚回来时位置才稳定 */

    /** 会话用量看板（抽屉）开关 */
    const [usageBoard, setUsageBoard] = createSignal(false);
    /** 上一帧的**末叶子 id** —— 「新块出现」与「同一块内流式增长」的判据（见 lib/chat-scroll.followPlan）。
     *  切会话时也会更新（跟随 effect 头部无条件写），故切回来不会被误判成"新块"。 */
    let prevTailId: string | null = null;

    createEffect(
        on(uri, (u, prev) => {
            // 切走前保存旧会话阅读位置 + 冲掉待写草稿。
            //
            // ⚠️ 这几行在**当前架构下走不到**：本页每个任务一个实例，`uri` 对单个实例是常量
            //  （切 tab = 本实例卸载 + 另一个挂载），所以真正的保存点在下面的 `onCleanup`。
            //  留着是因为 `TaskRunPage` 已写明"将来做 tab 保活时再改为逐实例传 uri" ——
            //  那时 `uri` 会变，这条路径就有了语义。
            if (prev) {
                // 存**锚点**（视口顶部那块 + 块内偏移），不存 scrollTop —— 见 ChatAnchor 的注释
                if (scrollRef) localChatStore.setScroll(prev, pickAnchorIn(scrollRef));
                void draftStore.flushNow(prev);
            }
            // 切走：停掉上一个会话的运行态轮询（只轮询当前打开的会话）
            unwatch?.();
            unwatch = null;
            // ##301：新会话的视口锚点从零开始（旧会话的块在新会话里不存在）
            vpAnchor = null;
            setScrollTop(0);
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

    // 跟随（##331 ①）：内容变化（trees 信号）→ 按 `followPlan` 决策，不是无脑滚到底。
    //
    // 为什么不是"贴底就钉到 scrollHeight"（原实现）：那样**高块**刷出来时视口停在它的**末行**
    //   （实测该块首行被推到容器顶上方 265px），用户看到结尾、要往回翻才看到开头。
    // 口径（lib/chat-scroll.followPlan）：新块矮 → 跟到底（IM 直觉）；新块高 → 首行贴视口顶；
    //   **同一块内流式增长 → 不动**（内容从屏幕下方自然长出）；用户上翻 → 一律不动（既有语义）。
    //
    // 顺序要求：必须声明在上方 uri 切换 effect 之后——Solid 按创建顺序执行 effect，
    //   切会话时 uri effect 先同步置 restoring 闸门，本 effect 才会让位给 restore 的定位。
    // 时机：createEffect 在 DOM 写入之后运行，故能读到新内容的几何；再补一帧 rAF 兜住
    //   布局后置变化（Markdown 撑高 / 估算高度换实测）。rAF 内重读 stick——用户若已上滚则放弃。
    createEffect(() => {
        const tailId = lastLeafId(localChatStore.trees);
        const prev = prevTailId;
        prevTailId = tailId; // 无条件更新（含 restoring 期间）：切回来才不会被误判成"新块"
        if (restoring || !stick()) return;
        const el = scrollRef;
        if (!el) return;
        const node = tailId ? blockElOf(el, tailId) : null;
        const plan = followPlan({
            stick: stick(), // 上方 `if (restoring || !stick())` 已保证为真，这里传函数值免得读成"与 stick 无关"（review1 R2）
            prevTailId: prev,
            tailId,
            blockTop: node ? blockTopIn(el, node) : 0,
            blockHeight: node ? node.getBoundingClientRect().height : 0,
            clientHeight: el.clientHeight,        });
        if (plan.kind === "idle") return;
        const apply = () => {
            const e2 = scrollRef;
            if (!e2 || !stick()) return;
            if (plan.kind === "bottom") {
                writeScrollTop(e2, e2.scrollHeight);
                return;
            }
            // 块顶在 rAF 里重新现量：布局后置变化会挪它
            const n2 = tailId ? blockElOf(e2, tailId) : null;
            writeScrollTop(e2, n2 ? blockTopIn(e2, n2) : plan.blockTop);
        };
        apply();
        requestAnimationFrame(apply);
    });

    // ─── 视口锚定（##301）──────────────────────────────────────────────────────
    //
    // 虚拟化后，行顶边 = **账面高度前缀和** ⇒ 账一变（前插补段 / 上方行被测量修正 /
    // 清空重置）所有行的绝对位置都变，而 scrollTop 是像素量、不会自己跟着走。
    // 这条 effect 把「视口顶那一块」放回它原来的屏幕位置，是"上滚 / 补段不跳"的唯一保证。
    //
    // 分工：贴着底（`stick`）时**让位给上面那条 followPlan**（它按末叶子决策：矮块跟到底 /
    // 高块首行贴顶），这条只管"用户在中间读历史"时的补偿 —— 两条各管一段，不抢。
    // 锚点必须在布局变化**之前**取（`captureAnchor` 挂在滚动事件上，见其注释）。
    // ⚠️ 别再各写一份补偿：位置只由这一条 + followPlan 决定。
    createEffect(() => {
        const L = layout();
        const el = scrollRef;
        if (!el || restoring || stick()) return;
        if (!vpAnchor) {
            captureAnchor(el); // 首个布局：以当前位置为锚（此后由滚动事件维护）
            return;
        }
        // ① 锚点块**还在窗口里**（常态：窗口上下各带 overscan）⇒ 按块身份精确落位。
        //    别在这里用"行的账面顶 − offset"近似 —— 那个式子漏掉块在行内的偏移，
        //    每次补偿都会把视口整体挪 δ（实测偏 101px，正是"补段完成后跳一下"的来源）。
        if (blockElOf(el, vpAnchor.id)) {
            applyAnchor(el, vpAnchor);
            return;
        }
        // ② 被摘出窗口（补段把内容推到窗口外）⇒ 先按**行**的账面顶把窗口挪过去，
        //    块上屏后由 `applyAnchor` 的连校收敛（它自带 3 帧静默退出）。
        const ri = anchorRowIndex(vpAnchor.id);
        if (ri < 0) {
            captureAnchor(el); // 锚点行没了（清空 / 换会话）⇒ 以当前位置重取
            return;
        }
        writeScrollTop(el, L.tops[ri]!);
        applyAnchor(el, vpAnchor);
    });

    // ─── agent 人物（模型/参数/行为指令都在人物定义里，这里只选"要谁干活"）───
    /** 本任务当前人物：任务绑定是权威（清单在 personaStore，未加载完时先用缺省名，不显示空） */
    const personaDef = () => personaStore.defOfLive(personaStore.idForTask());

    // 换绑与改定义都在人物面板里做（那里能看见"影响多少任务"）——这里只负责打开它。
    // 为什么不做成下拉快速切换：人物是**全局配置实体**，下拉只够"选"，看不见改动的波及面。

    /**
     * 真正发出去（门禁通过之后）：清输入框、清草稿、走 room 投递。
     * `sent` = 要发的正文（**转文件时是替换后的消息体**，不是用户原文）。
     */
    const deliver = async (u: string, sent: string, editorText: string) => {
        setInputValue("");
        // 内容已作为消息发出，草稿使命结束：清掉，避免下次进入看到已发送的旧文本
        void draftStore.clear(u, ["agent_input"]);
        setStick(true); // 刚发出，必然想看回复：无视之前是否在上方阅读
        // 走 **room 投递**（##377 第 17 刀 / ##166 §44.2 A）：无 `@` ⇒ focus（缺省 = 主人格）
        // ⇒ 与今天等价；`@dev` ⇒ 投给那个成员。实时显示与停止语义都不变（见 sendViaRoom 头注）。
        const ok = await localChatStore.sendViaRoom(u, sent);
        if (!ok) setInputValue(editorText); // 真失败（RPC 抛错）⇒ 把话还给用户，别"既没发出又被打字清空"
    };

    const submit = async () => {
        // 终态任务只读（##400）：服务端本就会拒（TurnGate），这里**不让用户白打一句话**
        // —— 拒信仍由服务端给（前端的只读不是判据，别指望它兜底）。
        if (closedInfo()) return;
        const text = inputValue().trim();
        // ⚠️ 不再因"有轮次在跑"而拦（##377 第 27 刀）：那条守卫是**旧通道**的遗迹 ——
        // 今天发送一律走 room（`sendViaRoom`），本窗口不接管任何流，忙不忙由 main 侧决定
        // （忙 ⇒ 插进正在跑的那一轮，见 `shared/room.deliveryPlanFor`）。
        // 拦掉它才是真 bug：任务页忙时按 Enter 什么都不发生（`live` 分支静默 return），
        // 而侧边栏同一句话却能发出去、还能在房间里查到。
        if (!text || !uri()) return;
        const u = uri()!;
        // ── 发送前门禁（##426 B）：只看**本条**消息的字符数；未超限 ⇒ 零打扰（直接发）──
        // 量的口径全在 main（单价快照 / 窗口占用 / token 估算各一份真源），这里只认 over。
        try {
            const gate = (await diyService.diy.agent.local.inputGate({ taskUri: u, text })) as InputGate;
            if (gate.over) {
                // 输入框**不动**：用户还得在里面继续编辑（取消 = 回到打字）
                setInputGateAsk({ text, gate });
                return;
            }
        } catch {
            /* 量不出来不拦发送：门禁是防护，不是判据（发送失败另有错误显示） */
        }
        await deliver(u, text, text);
    };

    /** 「转文件发送」：落盘 → 用返回的消息体（路径 + 前 20 行 + 总行数）发出去 */
    const sendViaFile = async () => {
        const ask = inputGateAsk();
        const u = uri();
        if (!ask || !u || gateBusy()) return;
        setGateBusy(true);
        try {
            const r = await diyService.diy.agent.local.pasteToFile({ taskUri: u, text: ask.text });
            setInputGateAsk(null);
            await deliver(u, r.message, ask.text);
        } catch (e) {
            // 失败必须说出来：内容还在输入框（原文没动），别让"点了没反应"变成猜
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToast(
                "error",
                `转文件失败：${msg}`,
                chatNotice(
                    "发送前门禁 · 转文件（##426）",
                    "内容原样还在输入框里，没有发出去；可以直接重试或改选「仍然发送」",
                    "会话页 submit 前的超长门禁：超阈值 → `agent.local.pasteToFile` 把正文落 $DIY_HOME/<taskUri>/gen/paste/，落盘失败就不发送（半途发送会让内容只存在上游历史里、本地无副本）。",
                ),
            );
        } finally {
            setGateBusy(false);
        }
    };

    /** 「仍然发送」：照发，不记后账（用户已看见三个数，选择权在他） */
    const sendAnyway = async () => {
        const ask = inputGateAsk();
        const u = uri();
        if (!ask || !u) return;
        setInputGateAsk(null);
        await deliver(u, ask.text, ask.text);
    };

    /**
     * 回车 = **发送**（不按"忙不忙"分流，##377 第 27 刀）。
     *
     * 修前：生成中按 Enter 走 `submitSteer` ⇒ 进插话队列（`_su*` 块），**不落 room** ——
     * 于是同一句话在任务页发过、却在房间页 / `room get` 里查不到，与侧边栏的"忙时进 room 排队"
     * 两套语义。修后：一律 `submit()`（先落 room 的 `say`），忙时由投递层插进正在跑的那一轮
     * （`deliveryPlanFor`，状态记 `ok` + 一句 note）。插话能力没丢，丢的只是"两条互不相认的通道"。
     */
    const submitByEnter = () => {
        void submit();
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

    /** 「立即发送」：整批现在送出去（服务端决定是加急到下一步还是立刻开一轮） */
    const flushSteerQueue = () => {
        const u = uri();
        if (u) void localChatStore.flushSteers(u);
    };

    /**
     * 「修改」：把一条待发送留言撤回编辑器。
     *
     * 输入框已有内容时**不覆盖**：接在一条 `---` 分隔线之后（用户要的是"补进来"；
     * 直接覆盖就是把他正在打的那半句冲掉 —— 那也是"丢了 = 用户白打"的数据）。
     * 撤回失败（RPC 错）时队列没动，此时**绝不改动输入框**：同一句话会同时出现在两处。
     */
    const editSteer = async (id: string) => {
        const u = uri();
        if (!u) return;
        const item = await localChatStore.takeSteer(u, id);
        if (!item) return;
        const cur = inputValue();
        const next = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n---\n\n${item.text}` : item.text;
        setInputValue(next);
        draftStore.set(u, "agent_input", next);
        focusInput();
    };

    /** 焦点送回输入框（撤回留言后要能立刻改；MdEditor 是 CodeMirror，focus 它的 contenteditable 即可） */
    const focusInput = () => {
        rootRef?.querySelector<HTMLElement>("[data-agent-input] .cm-content")?.focus();
    };

    return (
        <div
            ref={(el) => (rootRef = el)}
            class="flex flex-col h-full overflow-hidden"
            data-testid="local-chat-page"
            /* op 订阅健康度（idle|connecting|live|down）：**唯一**能一眼判"实时通道通不通"的位
               （单通道化后订阅坏了 = 一个字也看不见，与"模型在想"同形）。落成 DOM 属性 = 可被
               CDP/意图测试断言（`data-ops-down` 那条常驻条只是它的一个渲染分支）。 */
            data-ops-state={localChatStore.opsState}
        >
            <PersonaDrawer open={personaPanelOpen()} onClose={() => setPersonaPanelOpen(false)} />
            {/* 打开时顺手对一次账本（轮次间隙别人跑的那几轮不该漏） */}
            <UsageDrawer open={usageBoard()} uri={uri()} onClose={() => setUsageBoard(false)} />
            {/* L3：本轮逐步明细抽屉（覆盖式；turnId 页面级，单实例） */}
            <TurnUsageDetailDrawer
                turnId={usageDetail()}
                live={liveTurnId() === usageDetail()}
                onClose={() => setUsageDetail(null)}
            />
            {/* 流量抽屉（当前会话的请求/响应；错误块「查看实际请求 / 响应」深链打开） */}
            <TrafficDrawer />
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
                {/* LLM 流量入口：与错误块深链同一个抽屉。常驻在视图栏，用户随时能开，
                    不必先撞上一次错误才知道有这东西（##309(上游偶发 400 不可归因)）。 */}
                <button
                    class="btn btn-xs btn-ghost shrink-0"
                    data-testid="chat-traffic-btn"
                    data-tip="流量（当前会话实际发出的请求 / 响应）"
                    aria-label="流量"
                    onClick={() => trafficStore.openWith()}
                >
                    <span class="text-body leading-none">📡</span>
                </button>
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
                    <IconChevron open={globalLevel() > 1} class="h-3.5 w-3.5 opacity-40" />
                    <span class="text-body leading-none">{`${globalLevel()}/${TURN_LEVEL_MAX} 展开`}</span>
                </button>
                {/* 显示方式 = **一个开关的两态**，故用单个 `<>` 图标按钮（VSCode「切换源码」范式，##348 ④）。
                    原先摆两个按钮（MD 原文 / MD 渲染）像两个动作，其实是同一开关的两面，白占两格。
                    单按钮最容易犯的错是「看不出当前是哪态」，这里用三处一起说清，不靠用户猜：
                      · 图标按钮的**按下态**（`btn-active` + `aria-pressed` = 正处于原文态）
                      · tooltip 直接写**点一下会去哪**（不是描述当前态）
                      · `data-md` 给测试/自动化一个不随皮肤变的口径
                    用 daisyUI 的 `btn-active` 而不是 `swap`：swap 的两图标交替需要两块图标，
                    而这里只有一个 `<>`（态由底色表达）。 */}
                <button
                    class="btn btn-xs btn-ghost shrink-0"
                    classList={{ "btn-active": !md() }}
                    data-testid="chat-md-toggle"
                    data-md={md() ? "1" : "0"}
                    aria-pressed={!md()}
                    aria-label="Markdown 显示方式（原文 / 渲染）"
                    data-tip={md() ? "查看 Markdown 原文（纯文本）" : "回到 Markdown 渲染（富文本）"}
                    onClick={() => setMd(!md())}
                >
                    <IconCode class="h-3.5 w-3.5" />
                </button>
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

            {/* 段跳（##389 定位）后显示的是**历史**：块树里没有尾部那一段，必须给出显式回切出口 ——
                否则用户会以为"会话就到这里"，而其实新消息还在后面（且实时 op 此刻被丢弃，
                不会自己冒出来）。与 ops 断线条同理：状态的生命周期与状态本身等长。 */}
            <Show when={localChatStore.detached}>
                <div
                    data-chat-detached="1"
                    role="status"
                    class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-body"
                >
                    <span class="shrink-0 font-medium text-warning">正在查看历史</span>
                    <span class="opacity-70">检索定位到的那一段；新消息仍在继续写盘</span>
                    <button
                        class="btn btn-xs btn-warning ml-auto"
                        onClick={() => {
                            const u = uri();
                            if (u) void localChatStore.returnToTail(u).then(() => gotoBottom());
                        }}
                    >
                        回到最新
                    </button>
                </div>
            </Show>

            {/* 会话实时更新**中断常驻条**（##354 ③；判据 = `localChatStore.opsState === "down"`）。
                单通道化（##327）之后 op 订阅是实时显示的唯一通道 ⇒ 它断了 = 用户**一个字都看不到**，
                而那在界面上与"模型还在想"完全同形。常驻：只要有 `down` 这条就在，恢复（markOpsLive）
                才消失 —— 生命周期与故障本身等长；放在滚动区**之外**（不随消息滚走）。
                ##391：条上内容（文案 + 「详情」三段 + 每秒刷新的"已断多久"）收口在 OpsDownBar，
                与恢复 toast 共用同一份机制说明（`lib/notice-ops.ts`）—— 两处说法必须是一个故事。 */}
            <Show when={localChatStore.opsState === "down"}>
                <OpsDownBar />
            </Show>

            {/* 降级重建横幅（##424 刀 2）：`historyWindow` 回包带 `degraded` ⇒ 现在看到的
                不是 ops 明细，而是 `turns.jsonl` 折成的**结论文本记录**。
                为什么必须显式（用户口径）：ops 缺失/断代时静默给空栏，等于让用户以为
                “这场对话什么都没发生过”—— 那比少显示明细更坏。常量与文案归 shared。 */}
            <Show when={localChatStore.degraded}>
                {(d) => (
                    <div
                        class="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-body text-warning shrink-0"
                        data-degraded={d().cause}
                        data-degraded-turns={d().turns}
                        data-degraded-dangling={d().dangling}
                    >
                        <span aria-hidden="true">⚠</span>
                        <span>{degradedBannerText(d())}</span>
                    </div>
                )}
            </Show>

            {/* 块树滚动区 */}
            <div
                ref={(el) => (scrollRef = el)}
                class="diy-chat flex-1 overflow-y-auto px-4 py-3"
                /* 诊断 + 不静默：room 侧读到几条外部行、读失败的原因（失败只影响这一层） */
                data-room-rows={roomRows().length}
                data-room-says={roomFeed().filter((e) => e.kind === "say").length}
                data-room-replies={roomFeed().filter((e) => e.kind === "reply").length}
                data-room-note={roomNote() ?? ""}
                onScroll={(e) => {
                    // 视口锚点：跟着**实际滚动**走（此刻布局还没变，正是"变化前"的基准）。
                    // 但**我们自己写的**滚动不重取（见 `writeScrollTop`）：那会把锚点挪到旧窗口
                    // 里恰好路过视口顶的别的块上，用户正读的那一块就此丢失。
                    const at = e.currentTarget.scrollTop;
                    const ours = progWriteTop !== null && Math.abs(at - progWriteTop) < 1.5;
                    progWriteTop = null; // 只豁免**紧随的那一次**事件（见 `writeScrollTop`）
                    // ⚠️ **跟随态只由"人的滚动"决定**（##377 第 15 刀）：程序化滚动（`gotoBottom`
                    // 的钉底循环 / 锚点连校 / 布局补偿）也走 `writeScrollTop` ⇒ 也会触发本事件。
                    // 原来无条件 `setStick(nearBottom(...))` ⇒ 钉底循环**第一帧就把自己关掉**
                    // （那一刻还在半路上，`nearBottom` 为假 ⇒ stick=false ⇒ 下一帧 `if (!stick()) return`）
                    // —— 实测症状：打开会话/刷新后视口停在中段（`st=3136`，而底在 `~6974`），
                    // 最新轮不在虚拟化窗口里 = "看不见 agent 刚说的话"。
                    if (!ours) {
                        captureAnchor(e.currentTarget);
                        setStick(nearBottom(e.currentTarget));
                    }
                    // 窗口的输入（虚拟化）：scrollTop 一变就重算该挂哪几行
                    setScrollTop(at);
                    maybeLoadOlder(e.currentTarget);
                }}
            >
                {/* 上滚补历史（任务 293）：分页后首载只有「最近一段」，更早的在滚动到这里时补。
                    这一条既是进度指示、是"上面还有"的可见线索（没有它，滚到顶会被读成
                    「会话就这么多」，而其实老内容还在盘上），也是个**可点的补段入口**。
                    ⚠️ 它在**虚拟区之外**（顶部）：虚拟区只放"行"，它随滚动滚出视口 —— 与
                    非虚拟版的位置语义一致。 */}
                <Show when={localChatStore.hasOlder || localChatStore.olderLoading}>
                    {/* 可点：滚动只是**触发方式之一** —— 窗口渲染高度 ≤ 视口时用户根本
                        滚不出 scroll 事件，只有这条按钮能补出更早的轮（##293 review R5）。 */}
                    <button
                        type="button"
                        data-load-older="1"
                        class="mb-3 flex items-center justify-center gap-2 py-2 text-xs opacity-60 hover:opacity-100 w-full"
                        disabled={localChatStore.olderLoading}
                        onClick={loadOlderInto}
                    >
                        {localChatStore.olderLoading ? "正在加载更早的消息…" : "上滚加载更早的消息"}
                    </button>
                </Show>
                {/* 块树列（##301 视口虚拟化）：DOM 里只挂**视口附近若干轮**，其余行用高度账占位。
                    ⚠️ `data-chat-list` **不在这里** —— 它是**每轮的过程历史容器**，见 TurnView：
                    皮肤那条"贯穿线"要画在历史容器上，才只贯穿历史、不穿过结尾与状态。
                    几何（绝对定位 + 前缀和，行间距由账给出）见 lib/chat-virtual 头注。 */}
                <div class="relative" style={{ height: `${layout().total}px` }}>
                    <For each={windowRows()}>
                        {(row, i) => (
                            <VirtRow
                                rowKey={row.key}
                                top={layout().tops[win()[0] + i()] ?? 0}
                                ro={rowRO}
                                register={registerRow}
                            >
                                {row.tag === "turn" ? (
                                    <TurnView
                                        turnId={row.key}
                                        pin={pinned()}
                                        level={globalLevel()}
                                        histOpen={histOpenOf(row.key)}
                                        onCycle={() => toggleTurn(row.key)}
                                        conclusionLines={conclusionLines()}
                                        onResizeLines={changeConclusionLines}
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
                                ) : row.tag === "room-reply" ? (
                                    /* room 里「别人说的话」（##377 第 16 刀）：**只读回显**。
                                       `roomEventOf` 取不到 = 事件已滑出 limit 窗口（少见）——
                                       如实标出，不静默留白 */
                                    <Show
                                        when={roomEventOf(row.key)}
                                        fallback={
                                            <div class="text-body opacity-40">
                                                [room 事件已不在窗口内]
                                            </div>
                                        }
                                    >
                                        {(ev) => (
                                            <RoomReplyRow
                                                event={ev()}
                                                room={roomMeta()}
                                                roomId={uri() ?? ""}
                                                open={replyOpen()[ev().id] === true}
                                                onToggle={() =>
                                                    setReplyOpen((p) => ({
                                                        ...p,
                                                        [ev().id]: p[ev().id] !== true,
                                                    }))
                                                }
                                            />
                                        )}
                                    </Show>
                                ) : row.tag === "room-say" ? (
                                    /* room 里「我说的话」中**没投给主人格**的那些（##377 第 17 刀）：
                                       `@dev 帮我看看` —— ops 流里没有它，只能由 room 事件流画 */
                                    <Show
                                        when={roomEventOf(row.key)}
                                        fallback={
                                            <div class="text-body opacity-40">
                                                [room 事件已不在窗口内]
                                            </div>
                                        }
                                    >
                                        {(ev) => (
                                            <RoomSayRow
                                                event={ev()}
                                                room={roomMeta()}
                                                roomId={uri() ?? ""}
                                                openOf={(k) => steerOpen()[k] === true}
                                                onToggleTurn={(k) =>
                                                    setSteerOpen((p) => ({ ...p, [k]: p[k] !== true }))
                                                }
                                            />
                                        )}
                                    </Show>
                                ) : row.tag === "error" ? (
                                    /* 遗留的**根级** error 块（历史日志：旧版上限提示未挂 parent）。
                                       新日志已把提示挂进 turn（见 local-agent 的上限分支），但重放旧
                                       ops.jsonl 时根块仍会出现 —— 必须能读懂，不能只吐「[未知根 error]」。
                                       这类块一旦落盘就不再变，故按值取一次即可（不必走 getter） */
                                    <ErrorBox node={turnById(row.key)} />
                                ) : (
                                    <div class="text-body opacity-40">[未知根 {row.tag}]</div>
                                )}
                            </VirtRow>
                        )}
                    </For>
                </div>
                <Show when={roomNote()}>
                    <div class="text-warning text-caption mt-3" data-room-note-line>
                        {roomNote()}（只影响「别人说的话」这一层，本会话不受影响）
                    </div>
                </Show>
                <Show when={localChatStore.error}>
                    <div class="text-error text-body mt-3">{localChatStore.error}</div>
                </Show>
            </div>

            {/* 待发送插话横条（正常态）：贴着输入区上方一行 —— 队列是"还没发生的事"，
                不该混进上面的对话流（那里是历史） */}
            <Show when={!fullscreen()}>
                <SteerBar
                    items={localChatStore.steers}
                    onCancel={cancelSteer}
                    onToggleMode={toggleSteerMode}
                    onReorder={reorderSteers}
                    onEdit={(id) => void editSteer(id)}
                    onFlush={flushSteerQueue}
                />
            </Show>

            {/* 终态任务（##400）：输入区只读 + 一条静态提示。**拒绝的判据在服务端**，
                这里只是把"按了也没用"提前说出来，并给 ##391 三问详情。 */}
            <Show when={!fullscreen() && closedInfo()}>
                <div class="border-t px-3 py-2 shrink-0" data-session-closed>
                    <div class="flex items-start gap-2 rounded-field border border-base-300 bg-base-200 p-2 text-body">
                        <span class="opacity-70" aria-hidden="true">🔒</span>
                        <div class="min-w-0 flex-1">
                            <div class="font-semibold">
                                {closedInfo()!.reason} · 本会话不再接受新消息（历史仍可查看）
                            </div>
                            <div class="whitespace-pre-wrap opacity-70">{closedInfo()!.detail}</div>
                        </div>
                        <Show when={closedMeta()}>
                            {(m) => (
                                <NoticeDetail
                                    meta={m()}
                                    message={`${closedInfo()!.reason} · 本会话不再接受新消息`}
                                />
                            )}
                        </Show>
                    </div>
                </div>
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
                {/* R5 封顶加在**这个盒子**（= 用户眼里的「输入框」：正文 + 底部工具条）上，而不是
                    只加在正文宿主上。封顶的**主语**必须与需求一致 —— review2-2 实测：只封宿主时
                    整个输入区比 view/3 高出 50px（工具条那一行没算进去），后人按"整体 1/3"去改测试
                    就会对不上。`flex flex-col` 是让工具条（shrink-0）与正文（flex-auto）在盒子里分高度：
                    内容少时两者都按内容高（默认一行）；超过 max-height 时只有正文收缩 + 内部滚动。 */}
                <div
                    class={`rounded-field border border-base-content/20 bg-base-200 transition-colors focus-within:border-base-content ${fullscreen() ? "fixed inset-4 z-40 flex min-h-0 flex-col p-4" : "relative flex flex-col"}`}
                    style={fullscreen() ? undefined : { "max-height": inputMaxH() }}
                    /* 焦点锚点：撤回留言后要把光标送回这里（见 editSteer / focusInput） */
                    data-agent-input
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
                                onEdit={(id) => void editSteer(id)}
                                onFlush={flushSteerQueue}
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
                    {/* 全屏时 `flex-1` 不能丢：面板是 `fixed inset-4 flex flex-col`，正文宿主
                        没有 flex-grow 就成了内容高的项 → 内容少时缩成一条（R5 review1-1 实测：
                        面板 683px、编辑区仅 23px，「全文编辑」形同虚设）。
                        正常态用 `flex-auto`（basis = 内容高）而不是 `flex-1`（basis = 0）——
                        basis 0 在"高度由内容决定"的盒子里会把正文压成 0 高；而 basis auto 只在
                        盒子被 max-height 卡住时才收缩（收缩权在正文，工具条 shrink-0 不动）。 */}
                    <div
                        class={`min-h-0 overflow-auto px-2 pt-2 pr-8 ${fullscreen() ? "flex-1" : "flex-auto"}`}
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
                            editable={!closedInfo()}
                            onChange={(v) => {
                                setInputValue(v);
                                const u = uri();
                                if (u) draftStore.set(u, "agent_input", v);
                            }}
                            onEnter={submitByEnter}
                            /* 两个源：`##` 任务引用（第 11 刀）+ `@` 成员寻址（第 17 刀 —— 任务页
                               从"没有成员概念"变成"有 room 了"，成员源 = **本任务 room 的成员**，
                               与侧边栏各用各的）。`chatCompletions` 是 memo 稳引用（见其定义处）。 */
                            completions={chatCompletions()}
                            wrap
                            lineNumbers={fullscreen()}
                            embedded
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
                        <WindowRing uri={uri()} />
                        {/* ⌀ 底部汇总行的总均速度（##349 三档之"总均"；口径见 overallRate）：与轮尾那枚
                            不重复 —— 轮尾给"本轮"（⚡实时 / ⌀轮均），这里给"全局"。放在**常驻**位置 ——
                            轮尾那行会随滚屏移出视野，而"整体跑得快不快"是常驻参考。 */}
                        <OverallRateChip rate={overallRate()} />
                        <div class="flex-1" />
                        {/* 停止（两种观感：收尾中 / 生成中）+ **发送（恒在）**。
                            停止按钮**不分谁发起的**：main 报告活跃就给入口（含 CLI 那轮）；
                            外观沿用 steer 分支的 aura 装饰。
                            ⚠️ 发送按钮不再藏起来（##377 第 27 刀）：忙时它照样能按 —— 那条发言
                            先落 room，再由投递层插进正在跑的那一轮（与侧边栏同一套语义）。
                            原来"忙时只给停止、另给一个小『留言』按钮"= 两个入口两套语义，
                            而『留言』那条根本不进 room。 */}
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
                        </Switch>
                        {/* 发送：**恒在**（忙时 = 排队/插话，见上） */}
                        <button
                            class="btn btn-primary btn-sm"
                            data-tip={
                                localChatStore.view.busy
                                    ? "发送（回车）：本轮在跑 ⇒ 这句话投进当前这轮（下一步生效），并落进房间"
                                    : "发送（回车发送 / Shift+回车换行）"
                            }
                            onClick={() => void submit()}
                        >
                            发送
                        </button>
                    </div>
                </div>
            </div>

            <Show when={gensOpen() && uri()}>
                <CompactHistoryPanel uri={uri()!} onClose={() => setGensOpen(false)} />
            </Show>
            {/* 数据层检索面板（##389）：⌘⇧F 开合；「跳」走本组件的 locateHit（见其上注释） */}
            {/* 只由**当前任务这一页**渲染：多开 tab 时本组件可能同时存活多份，而面板状态是
                单例 store —— 不判归属就会出现两个面板（一个查 A、一个查 B），互相盖住。 */}
            <Show when={chatFindStore.open && chatFindStore.taskUri === uri()}>
                <ChatFindPanel
                    taskUri={uri}
                    onLocate={locateHit}
                    onClose={() => {
                        chatFindStore.close();
                        clearHitHighlight();
                    }}
                />
            </Show>
            {/* 超长输入门禁（##426 B）：只有 over 才会挂上这个节点 */}
            <Show when={inputGateAsk()}>
                {(ask) => (
                    <InputLimitDialog
                        gate={ask().gate}
                        busy={gateBusy()}
                        onCancel={() => setInputGateAsk(null)}
                        onToFile={() => void sendViaFile()}
                        onStillSend={() => void sendAnyway()}
                    />
                )}
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

import { createContext, createEffect, createMemo, createSignal, For, Match, Show, Switch, useContext } from "solid-js";
import type { JSX } from "solid-js";
import { loadFullBlockFields, localChatStore } from "../../store/localChatStore";
import { IconExpand, RowGutter } from "@diy-agent/ui-kit";
import { chatNotice, DETAIL_HISTORY } from "../../lib/notice-chat";
import { trafficStore } from "../../store/trafficStore";
import { notificationStore } from "../../store/notificationStore";
import { detachablesStore } from "../../store/detachablesStore";
import { MarkdownView } from "../MarkdownView";
import { nearBottom as libNearBottom, type ChatAnchor } from "../../lib/chat-scroll";
import { countLines, firstLine, previewLines } from "../../lib/chat-text";
import type { BlockNode } from "../../../main/services/local-blocks";
import { INTERRUPTED_TOOL_NOTICE } from "../../../main/services/local-blocks";
import { composeTail, endLeafTip, expandableOf, fmtBytes, fmtMs, intentOf, isInterruptedToolBlock, historyOpenOf, isUserText, leadUsers, leavesOf, procOpenOf, receiptStateOf, procStatusOf, spentOf, tailOf, turnRows, waitTextOf, type ProcTone, type TurnRow } from "../../lib/chat-fold";

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
export function DisclosureHead(props: {
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
export const HISTORY_TEXT_FOLD_LINES = 3;
export const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

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
export const TOP_TRIGGER_PX = 240;
// `STICK_PX` / `nearBottom` 已抽到 `lib/chat-scroll`（##377 第 19 刀：room 侧事件流
// 也要同一套跟随判据，两处各写一份必然漂移）。
export const nearBottom = (el: HTMLElement) => libNearBottom(el);

/** 块树里有没有这个 id（DFS；虚拟化下"块 → 行"的定位用，见 `anchorRowIndex`） */
export function containsBlockId(n: BlockNode, id: string): boolean {
    if (n.id === id) return true;
    for (const c of n.children) if (containsBlockId(c, id)) return true;
    return false;
}

/** 按块 id 找 DOM（滚动容器内的块）—— 找不到 = 该块还没上屏（布局未稳 / 已被移除）。
 *  `CSS.escape`：块 id 形如 `t1791126774555_s1_a`，虽然当前都是安全字符，也照规矩转义。 */
export function blockElOf(el: HTMLElement, id: string): HTMLElement | null {
    return el.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
}

/** 块在**内容坐标系**里的顶（px）：屏幕坐标差 + 当前 scrollTop —— 与滚动位置无关的量 */
export function blockTopIn(el: HTMLElement, node: HTMLElement): number {
    return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/**
 * 视口顶部那一块 + 它在容器内的相对偏移（≤0 = 块顶被滚出容器顶）—— **阅读位置的锚点**（##331 ③）。
 *
 * 为什么锚 `[data-block-id]` 而不是 `[data-turn-id]`：一轮里可能有很多块，
 * 轮粒度太粗（长轮里切走切回想回到"同一段正文"，不是"同一轮"）。
 */
export function pickAnchorIn(el: HTMLElement): ChatAnchor | null {
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
export function PlainText(props: { text: string; class?: string }) {
    return (
        <div class={`whitespace-pre-wrap break-words text-prose leading-relaxed ${props.class ?? ""}`}>
            {props.text}
        </div>
    );
}

/** assistant 正文（Markdown 富文本）：与原文模式共用同一数据源，仅渲染方式不同 */
export function MarkdownText(props: { text: string; streaming: boolean }) {
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
export function turnById(id: string): BlockNode {
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
export function leafById(turnId: string, blockId: string): BlockNode {
    return leavesOf(turnById(turnId)).find((n) => n.id === blockId) ?? EMPTY_LEAF;
}

/** 本轮是否已出现助理侧内容（think/tool/text-assistant/error/plan）。
 *  发送后到首个助理事件之间有一段真空期（握手 + 上游首 token 往返），
 *  此时界面上只有 user 气泡，需要 loading 图标填充"正在处理"的反馈；
 *  一旦助理内容出现即让位给真实消息（含流式思考过程）。 */
export function hasAssistantContent(turn: BlockNode): boolean {
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
export function reuseRows(prev: TurnRow[], next: TurnRow[]): TurnRow[] {
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
export function summaryOf(n: BlockNode, open = true, turn?: BlockNode): string {
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
export const [detachNote, setDetachNote] = createSignal<Record<string, string>>({});

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
export function ProcessRow(props: {
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
export function TailBox(props: {
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
export function EndLeafBox(props: {
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

function traceIdOf(msg: string): string | null {
    const m = msg.match(/trace_id[:\s]+([0-9a-fA-F_-]{8,})/);
    return m ? m[1]! : null;
}

export function ErrorBox(props: {
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

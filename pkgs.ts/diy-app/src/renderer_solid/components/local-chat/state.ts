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
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { localChatStore } from "../../store/localChatStore";
import { useLocate } from "./useLocate";
import { useRoomFeed } from "./useRoomFeed";
import { personaStore } from "../../store/personaStore";
import { PersonaDrawer } from "../PersonaDrawer";
import { TurnUsageDetailDrawer, SessionUsageChip, WindowRing, OverallRateChip, sessionAvgRate, UsageDrawer, UsageHoverCard, armHoverClose, cancelHoverClose, type UsageHoverState } from "../UsagePanel";
import { CompactHistoryPanel } from "../CompactSessionPanel";
import { TrafficDrawer } from "../TrafficDrawer";
import { ConfirmDialog, IconChevron, IconCode, IconCompress, IconExpand, IconTrash } from "@diy-agent/ui-kit";
import { InputLimitDialog } from "../InputLimitDialog";
import type { InputGate } from "../../../shared/context/input-limit";
import { OpsDownBar } from "../OpsDownBar";
import { chatNotice, DETAIL_CHAT_FIND } from "../../lib/notice-chat";
import { draftStore } from "../../store/draftStore";
import { trafficStore } from "../../store/trafficStore";
import { notificationStore } from "../../store/notificationStore";
import { taskStore } from "../../store/taskStore";
import { NoticeDetail } from "../NoticeDetail";
import { isTerminalSessionState, TERMINAL_STATE_REASON, terminalSessionDetail } from "../../../shared/turn-gate";
import { Caches, CONCLUSION_LINES_MAX, CONCLUSION_LINES_MIN } from "../../lib/ui-state";
import { HeightLedger, stackRows, windowRange } from "../../lib/chat-virtual";
import { chatFindStore, type ChatFindHit } from "../../store/chatFindStore";
import { chatNavStore, type ChatNavTarget } from "../../store/chatNavStore";
import { detachablesStore } from "../../store/detachablesStore";
import { findStore } from "../../store/findStore";
import { ChatFindPanel } from "../ChatFindPanel";
import { clearHitHighlight, paintHitHighlight } from "../../lib/hit-highlight";
import { MdEditor } from "../MdEditor";
import { memberCompletion, taskCompletion } from "../../lib/completions";
import { MAIN_MEMBER_ID, opsOwnsEvent, type Room, type RoomEvent } from "../../../shared/room";
import { diyService } from "../../lib/rpc";
import { layoutStore } from "../../store/layoutStore";
import { anchorScrollTop, anchorTick, clampScrollTop, followPlan, lastLeafId, type AnchorTickState, type ChatAnchor } from "../../lib/chat-scroll";
import { userStamp } from "../../lib/user-stamp";
import type { ReasoningEffort } from "../../../main/services/local-agent";
import { reasoningEffortLabel } from "../../../shared/reasoning-effort";
import { VIEW_BAR_H, chatInputMaxHeight } from "../../lib/layout-metrics";
import type { BlockNode } from "../../../main/services/local-blocks";
import { DEFAULT_TURN_LEVEL, TURN_LEVEL_MAX, cycleTurnLevel, isTurnLevel, historyOpenOf, liveTurnOf, turnLevelTip, turnRows, type TurnLevel } from "../../lib/chat-fold";
import { degradedBannerText } from "../../../shared/degraded-history";
import {
    ErrorBox,
    TOP_TRIGGER_PX,
    blockElOf,
    blockTopIn,
    containsBlockId,
    detachNote,
    nearBottom,
    pickAnchorIn,
    setDetachNote,
    turnById,
} from "./MessageStream";
import { FullscreenModal, RoomReplyRow, RoomSayRow, SteerBar, VirtRow } from "./RoomRows";
import { TurnView } from "./TurnView";

// 组装层：`LocalChatPage` 导出名不变（##448 刀 2）。渲染原语与轮 / room 行在兄弟文件里，
// 这里只保留页面级状态与组装。
export { ChatView } from "./MessageStream";
export { TurnView } from "./TurnView";

// ─── 页面 ───────────────────────────────────────────


export interface LocalChatPageProps {
    uri?: string;
    /**
     * 给了它 = 本会话区负责「右栏（成员栏）默认开合」（##166 §44.1 ②，值 = pageId）。
     *
     * 为什么落在这里（而不是右栏那个 view 里）：**右栏收起时 `ViewGrid` 根本不挂载它**
     * （`groups()` 按 `plan().visibleAreaIds` 过滤）⇒ 由被收起者自己"发现自己该展开"是死结。
     * 而本组件（中心会话区）恒挂载、且成员表本来就在它手里（`loadRoomFeed`）。
     */
    rosterAutoFor?: string;
}

/**
 * 页面级状态（原 `LocalChatPage` 组件体，##448 刀 2 逐字搬出）。
 * 拆分的唯一目的：让组装层（`index.tsx`）只剩根节点与三块渲染；所有 signal / effect
 * 仍在这一个函数里（作用域与创建顺序不变 ⇒ 行为不变）。
 */
/** 页面 API 的形状 = 这个 Hook 的返回值（context / 子组件的类型都从它来，不另写一份）。 */
export type LocalChatApi = ReturnType<typeof useLocalChatPage>;

export function useLocalChatPage(props: LocalChatPageProps) {
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
    // ─── room：本任务的时间线第二源（##377 第 16/17 刀）────────────────────
    // 搬进 `useRoomFeed`（##448 刀 2）：依赖只有 `uri` / `rosterAutoFor`，状态归 Hook。
    const room = useRoomFeed({ uri, rosterAutoFor: props.rosterAutoFor });
    const {
        applyRosterAuto,
        chatCompletions,
        loadRoomFeed,
        mainMemberId,
        replyOpen,
        roomEventOf,
        roomFeed,
        roomMeta,
        roomNote,
        roomRows,
        rootRows,
        setReplyOpen,
        setRoomFeed,
        setRoomMeta,
        setRoomNote,
        setSteerOpen,
        steerOpen,
    } = room;

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

    // ─── 数据层检索的定位（##389）+ 作业来源定位（##408 刀 6）──────────
    // 搬进 `useLocate`（##448 刀 2）。调用点不变 ⇒ effect / 闭包创建顺序与原来一致。
    // 面板归属哪个任务：跟着 uri 走（首挂时 uri 可能还没到）。`ownerUri` 记下**本页认领过的**那个 uri：
    // 卸载时按它交还（不能拿卸载那一刻的 uri() 去比 —— 那时 props 可能已被上层置空）。
    let ownerUri: string | null = null;
    const locate = useLocate({
        uri,
        scrollEl: () => scrollRef,
        layout,
        writeScrollTop,
        anchorRowIndex,
        renderedTurnIds,
        setStick,
        histOpenOf,
        setFoldMarks,
        setPinned,
        onClaim: (u) => (ownerUri = u),
    });
    const { flashTurn, flashBlock, locateHit, locateJobTarget, revealBlock, scrollToBlock, scrollToTurn } = locate;

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

    return {
    uri,
    taskState,
    closedInfo,
    closedMeta,
    inputValue,
    setInputValue,
    moreOpen,
    setMoreOpen,
    gensOpen,
    setGensOpen,
    personaPanelOpen,
    setPersonaPanelOpen,
    fullscreen,
    setFullscreen,
    setRootEl: (el: HTMLDivElement | undefined) => (rootRef = el),
    scrollEl: () => scrollRef,
    setScrollEl: (el: HTMLDivElement | undefined) => (scrollRef = el),
    rootEl: () => rootRef,
    viewH,
    setViewH,
    inputMaxH,
    stick,
    setStick,
    restoring,
    unwatch,
    scrollTop,
    setScrollTop,
    chatVpH,
    setChatVpH,
    ledgerTick,
    setLedgerTick,
    OVERSCAN_PX,
    ledgers,
    curLedger,
    touchLedger,
    rowKeyOf,
    registerRow,
    applyHeights,
    rowRO,
    vpAnchor,
    captureAnchor,
    progWriteTop: () => progWriteTop,
    setProgWriteTop: (v: number | null) => (progWriteTop = v),
    writeScrollTop,
    anchorRowIndex,
    gotoBottom,
    loadOlderInto,
    maybeLoadOlder,
    applyAnchor,
    restore,
    applyDraft,
    liveTurnId,
    overallRate,
    md,
    setMdRaw,
    setMd,
    levelFromCache,
    globalLevel,
    setGlobalLevelRaw,
    setGlobalLevel,
    foldMarks,
    setFoldMarks,
    histOpenOf,
    toggleTurn,
    cycleAllLevels,
    conclusionLines,
    setConclusionLines,
    changeConclusionLines,
    confirmClear,
    setConfirmClear,
    inputGateAsk,
    setInputGateAsk,
    gateBusy,
    setGateBusy,
    pinned,
    setPinned,
    togglePin,
    usageHover,
    setUsageHover,
    usageDetail,
    setUsageDetail,
    hoverUsageIn,
    hoverUsageOut,
    full,
    setFull,
    roomMeta,
    setRoomMeta,
    roomFeed,
    setRoomFeed,
    roomNote,
    setRoomNote,
    mainMemberId,
    applyRosterAuto,
    loadRoomFeed,
    chatCompletions,
    roomRows,
    roomEventOf,
    replyOpen,
    setReplyOpen,
    steerOpen,
    setSteerOpen,
    rootRows,
    allRows,
    prevKeysRef,
    rowKeys,
    layout,
    win,
    windowRows,
    renderedTurnIds,
    flashTurn,
    scrollToTurn,
    locateHit,
    flashBlock,
    scrollToBlock,
    locateJobTarget,
    revealBlock,
    usageBoard,
    setUsageBoard,
    prevTailId,
    personaDef,
    deliver,
    submit,
    sendViaFile,
    sendAnyway,
    submitByEnter,
    cancelSteer,
    toggleSteerMode,
    reorderSteers,
    flushSteerQueue,
    editSteer,
    focusInput,
    };
}

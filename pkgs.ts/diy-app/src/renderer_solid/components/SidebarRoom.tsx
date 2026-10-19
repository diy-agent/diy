/**
 * SidebarRoom — 全局**侧边栏助手 room**（##166 §30 需求 / §31 待拍 82+85 拍板）。
 *
 * 定位：**room 的实验田**，不属任何任务、**独立于路由**（不打开任何任务时也在）。
 * 与任务 room 的差别只有 id 的来历：
 *   · 任务 room：id = taskUri（§28.7 G）；
 *   · 侧边栏 room：id = `agent:room:ui/sidebar-<实例>`（§31 拍板）—— `<实例>` 由现有实例身份派生
 *     （`getAppInfo` 的 env + diyHome，见 `shared/room::sidebarRoomId`）。
 * 除此之外**完全同构**（成员表 / 投递 / 署名 / 进度），所以复用同一批组件：
 *   · `RoomRoster` —— 成员栏 + 邀请（与房间页同一份）；
 *   · `ChatView` + `TurnView` —— 进度 = **任务对话那套块渲染**（§28.7 A 硬要求：不许另写一套）；
 *   · `MdEditor` —— 输入区 = **任务对话那台编辑器**（##377 第 9 刀 C：别另写第二套）；
 *   · 判据（`parseAddress` / `resolveRecipients` / `deliveryHint`）全走 `shared/room`（与服务端同一份）。
 *
 * 主人格 backend（##166 §30 owner 补拍 · 选 a）：侧边栏没有宿主 task 可绑 ⇒
 * 主人格 = **缺省人物 + 影子 task**（与被邀请成员同一条规则，不搞特例）—— 由 main 侧
 * `room-service::ensureSidebarRoom` 在**首次**取房间时建好，UI 不参与。
 *
 * ##377 第 9 刀（owner 派活 · 用户三改）—— **三态**：
 *   · `ball`  球态：**左缘**一颗悬浮球（用户要求从右缘挪过来）；
 *   · `normal` 普通态：**viewbar 一条细条** + 会话流 + 输入框 —— 标题栏 / 成员栏 / 绑定任务入口全删；
 *   · `max`   最大化态：**多出右侧边栏**（成员栏：成员 / 邀请（选人物）/ 当前接受者 / 移出）。
 * 切换按钮**单个**（用户明确要求）：球 → 普通态；普通态 / 最大化态内点它 → 最大化 ⇄ 恢复。
 * ⚠️ 口径歧义（已回报 owner）：用户只说「最大化和恢复的单个切换按钮」，**没说怎么回球态** ——
 * 本实现额外给 `Esc`（键盘入口，不占 viewbar 元素）；owner 看过截图后再定。
 * 宽度可拖（左缘 grip，复用 `TaskDetailPanel` 的既有模式）+ 宽度记忆（localStorage）。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import {
    deliveryHint,
    deliveryStatusText,
    isAllAddress,
    memberAvatar,
    memberColor,
    memberName,
    orderedMembers,
    parseAddress,
    resolveMember,
    resolveRecipients,
    shortName,
    sidebarRoomId,
    type DeliveryStatus,
    type Room,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";
import { ChatView, TurnView } from "./LocalChatPage";
import { MdEditor } from "./MdEditor";
import { memberCompletion, taskCompletion } from "../lib/completions";
import { onStreamScroll, pinnedTo, streamFollowInit, type StreamFollowState } from "../lib/chat-scroll";
import { RoomRoster, type RosterMemberL1 } from "./RoomRoster";
import { PersonaDrawer } from "./PersonaDrawer";
import type { BlockNode } from "../../main/services/local-blocks";

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 一条 reply 的进度（该成员会话的那一轮）—— 与房间页同一形状 */
interface TurnState {
    turn: BlockNode | null;
    taskUri: string;
    turnId: string;
    live: boolean;
    error?: string;
}

/**
 * 两态（##377 第 13 刀）：球态 / 面板态。
 *
 * ⚠️ 第 9 刀那套「normal / max（max = 多出**右侧**成员栏）」已废 —— §39.2 ② 把成员列表
 * 改到**面板左缘的抽屉**（向左拉出、不挤压会话区），于是"右侧成员栏"没有了，
 * "最大化"这个模式也随之失去含义。成员抽屉是**独立开关**，不属于任何面板模式。
 */
type SidebarMode = "ball" | "normal";

const W_KEY = "diy.room.sidebar.width";
/** 缺省宽（§39.2 ①：420 → 500，用户「右边空荡有点大，空间有点浪费」） */
const W_DEFAULT = 500;
const W_MIN = 320;
/** 成员抽屉宽度（向左拉出、右边界 = 面板左边界） */
const ROSTER_W = 240;
/** 左缘成员抽屉把手宽度（§39.2 ②：≤ 现状球宽的 2/3） */
const ROSTER_HANDLE_W = 20;
/**
 * hover 关闭的**滞回**延迟（§39.2 ④，本刀最容易翻车的一条）：
 * 鼠标从把手移到面板/输入框的途中不能关 —— 没有它，鼠标一离开把手面板就没了、**根本没法打字**。
 * 复用 §38.3 那套 `hoverHideTimer` 的现成模式（离开延迟关 + 进入即取消）。
 */
const HOVER_HIDE_MS = 400;

function clampW(w: number): number {
    const max = Math.max(W_MIN + 100, window.innerWidth - 120);
    return Math.min(Math.max(w, W_MIN), max);
}

function hms(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

function statusClass(s: DeliveryStatus): string {
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

export function SidebarRoom() {
    /** 两态（缺省球态 —— 它常驻全局，不能一上来就挡住主界面） */
    const [mode, setMode] = createSignal<SidebarMode>("ball");
    /** 成员抽屉（左缘把手控制；独立开关，不挤压会话区） */
    const [rosterOpen, setRosterOpen] = createSignal(false);
    /** 固定态：点把手 = 常驻（否则 hover 开关，鼠标移走自动收）——§39.2 ④ 的逃生口 */
    const [pinned, setPinned] = createSignal(false);
    /** 三级披露：人物编辑半截页（复用 `PersonaDrawer`，不新写一套） */
    const [personaOpen, setPersonaOpen] = createSignal(false);
    const [personaTarget, setPersonaTarget] = createSignal<string | null>(null);
    let panelRef: HTMLDivElement | undefined;
    let hideTimer: number | undefined;
    /** 会话区宽度（拖宽改它；最大化态在它之外**另加**成员栏，故整体变宽而会话区不变） */
    const [width, setWidth] = createSignal<number>(
        Number(localStorage.getItem(W_KEY)) || W_DEFAULT,
    );
    const [roomId, setRoomId] = createSignal<string | null>(null);
    const [room, setRoom] = createSignal<Room | null>(null);
    const [events, setEvents] = createSignal<RoomEvent[]>([]);
    const [badLines, setBadLines] = createSignal(0);
    const [err, setErr] = createSignal<string | null>(null);
    const [roster, setRoster] = createSignal<RosterMemberL1[]>([]);
    const [turns, setTurns] = createSignal<Record<string, TurnState>>({});
    const [folded, setFolded] = createSignal<Record<string, boolean>>({});
    const [pin, setPin] = createSignal<Record<string, boolean>>({});
    const [input, setInput] = createSignal("");
    /** 在飞的 post 条数（计数不是布尔：允许连发，同一成员在服务端排队 —— 用户口径「单成员串行」） */
    const [pendingPosts, setPendingPosts] = createSignal(0);
    const busy = () => pendingPosts() > 0;
    let streamRef: HTMLDivElement | undefined;

    /**
     * 事件流跟随态（##377 第 19 刀）：**贴底才跟随**。
     *
     * 原先取数后无条件 `streamRef.scrollTop = scrollHeight`，而取数是 2.5s 一次的轮询 ——
     * 用户往上翻，最多 2.5 秒就被拽回底部（实测滚到中段 1.6s 后回到距底 0px）
     * = 用户报的「room 的会话根本无法翻越」。语义与任务页同一套（stick-to-bottom），
     * 判据（含"程序化滚动也会发 scroll 事件"这一坑）在 `lib/chat-scroll.onStreamScroll`。
     */
    const [stick, setStick] = createSignal(true);
    /** 我们刚写下的 scrollTop（豁免紧随的一次 scroll 事件）—— 见 `StreamFollowState` */
    let progWrite: number | null = null;
    const followNow = (): StreamFollowState => ({ stick: stick(), progWrite });
    const setFollow = (s: StreamFollowState): void => {
        progWrite = s.progWrite;
        if (s.stick !== stick()) setStick(s.stick);
    };
    /** 唯一的程序化滚动出口：钉到底并把跟随态记为贴底。
     *  `force` = 用户的明确意图（自己发言 / 打开面板 / 点「回到最新」）—— 那时无视当前阅读位置。 */
    const pinBottom = (el: HTMLDivElement, force = false): void => {
        if (!force && !stick()) return;
        el.scrollTop = el.scrollHeight;
        setFollow(pinnedTo(el.scrollTop));
    };

    const ordered = createMemo(() => orderedMembers(room()));
    /**
     * 输入框补全源（##377 第 11 刀）：`@` 成员 + `##` 任务。
     *
     * ⚠️ 必须 `createMemo`：`memberCompletion(...)` 每次调用都返回**新函数**，直接写进 JSX 会让
     * `MdEditor` 每次渲染都重配补全扩展（面板被重置，正选候选时列表消失）。
     * memo 的元素引用稳定 ⇒ 只在真的换房间时才重配。
     *
     * `@` 源读的是**当前房间的成员**（与投递同一份数据）—— 成员变化（邀请 / 移出）时
     * `room()` 变 ⇒ memo 重算 ⇒ 新闭包读到新成员表 ✓
     */
    const completions = createMemo(() => [memberCompletion(() => room()?.members ?? []), taskCompletion]);
    const human = createMemo(() => room()?.members.find((m) => m.kind === "human") ?? null);
    const focusMember = createMemo(() => room()?.members.find((m) => m.id === room()?.focus) ?? null);
    /** 面板宽（成员抽屉在它**左侧**另占地方，不从这里扣） */
    const panelW = createMemo(() => width());

    const avatarOf = (id: string): string => {
        const list = ordered();
        const i = list.findIndex((m) => m.id === id);
        return memberAvatar(i >= 0 ? list[i]! : { id }, i);
    };
    const colorOf = (id: string): string =>
        memberColor(room()?.members.find((x) => x.id === id) ?? { id });

    const hint = createMemo(() => {
        const r = room();
        if (!r) return "";
        const addr = parseAddress(input());
        const explicit = addr.tos.map((t) => (isAllAddress(t) ? "all" : resolveMember(r, t)));
        // self = 人成员（`@` 自己 = 笔记，##166 §38.2）—— 与服务端 `postToRoom` 同一份判据
        const { recipients, routing } = resolveRecipients(explicit, r.focus, r.members, human()?.id);
        return deliveryHint(recipients, r, routing);
    });

    const loadRoster = async (id: string): Promise<void> => {
        try {
            const r = await diyService.diy.room.roster({ id });
            setRoster(r.members as RosterMemberL1[]);
        } catch {
            /* L1 是附加信息：读不到就空着，下一轮再试 */
        }
    };

    const loadRoom = async (id: string, opts: { soft?: boolean } = {}): Promise<void> => {
        try {
            const r = await diyService.diy.room.get({ id, limit: 300 });
            setRoom(r.room);
            setEvents(r.events);
            setBadLines(r.badLines);
            if (!opts.soft) {
                setErr(null);
                setFollow({ ...streamFollowInit }); // 起手 / 切房间：新房间从最新看起
            }
            void loadRoster(id);
            // 取数**不**无条件钉底（那正是「无法翻越」的根因）：贴底才跟随
            queueMicrotask(() => {
                if (streamRef) pinBottom(streamRef);
            });
        } catch (e) {
            if (!opts.soft) setErr(`读房间失败：${msgOf(e)}`);
        }
    };

    const loadTurn = async (eventId: string, opts: { soft?: boolean } = {}): Promise<void> => {
        const id = roomId();
        if (!id) return;
        try {
            const r = await diyService.diy.room.turn({ id, event: eventId, member: undefined, turn: undefined });
            setTurns((prev) => ({
                ...prev,
                [eventId]: { turn: r.turn as BlockNode | null, taskUri: r.taskUri, turnId: r.turnId, live: r.live },
            }));
        } catch (e) {
            if (opts.soft) return;
            setTurns((prev) => ({
                ...prev,
                [eventId]: { turn: null, taskUri: "", turnId: "", live: false, error: msgOf(e) },
            }));
        }
    };

    /** 起手：拿实例身份 → 派生侧边栏 room id → 确保房间存在（main 侧建主人格 = 缺省人物 + 影子 task） */
    onMount(() => {
        void (async () => {
            try {
                const info = await diyService.diy.getAppInfo({});
                const id = sidebarRoomId(info.env, info.diyHome);
                setRoomId(id);
                await diyService.diy.room.create({ id, title: "侧边栏助手", human: undefined });
                await loadRoom(id);
            } catch (e) {
                setErr(`侧边栏房间起不来：${msgOf(e)}`);
            }
        })();
    });

    // 轻量轮询：别的窗口 / CLI 的发言、排队状态变化、正在跑的那几轮（本切片无推送通道）
    onMount(() => {
        const t = setInterval(() => {
            const id = roomId();
            if (!id) return;
            void loadRoom(id, { soft: true });
            for (const [eid, st] of Object.entries(turns())) if (st.live) void loadTurn(eid, { soft: true });
        }, 2500);
        onCleanup(() => clearInterval(t));
    });

    // Esc 回球态（⚠️ 口径歧义处置，见文件头注：用户只说了"最大化和恢复的单个切换按钮"）
    onMount(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            // 逐层收：人物抽屉 → 成员抽屉 → 面板
            // ⚠️ `PersonaDrawer` **自己不处理 Esc**（实测按了没反应）⇒ 这里必须自己关它
            if (personaOpen()) {
                setPersonaOpen(false);
                const id = roomId();
                if (id) void loadRoom(id, { soft: true }); // 待决 105：关闭即重取
                return;
            }
            if (rosterOpen()) {
                setRosterOpen(false);
                return;
            }
            if (mode() !== "ball") {
                setPinned(false);
                setMode("ball");
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    // 窗口变窄时把宽度收回合法区间（否则面板会撑出屏幕）
    onMount(() => {
        const onResize = (): void => {
            setWidth((w) => clampW(w));
        };
        window.addEventListener("resize", onResize);
        onCleanup(() => window.removeEventListener("resize", onResize));
    });

    /** 左缘拖宽（复用 `TaskDetailPanel.tsx:106` 的既有模式：面板在右 ⇒ 鼠标左移 = 变宽） */
    const onGripDown = (e: MouseEvent): void => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width();
        const move = (ev: MouseEvent): void => {
            setWidth(clampW(startW + (startX - ev.clientX)));
        };
        const up = (): void => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            localStorage.setItem(W_KEY, String(width()));
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };
    const resetW = (): void => {
        setWidth(W_DEFAULT);
        localStorage.setItem(W_KEY, String(W_DEFAULT));
    };

    // ── hover 开关 + **滞回**（§39.2 ④：本刀最容易翻车的一条）────────────────────
    const cancelHide = (): void => {
        if (hideTimer !== undefined) window.clearTimeout(hideTimer);
        hideTimer = undefined;
    };
    /** 面板里还有焦点（正在打字）⇒ 鼠标移开也**不关**（"打字期间不会关"） */
    const typingInside = (): boolean => !!panelRef && panelRef.contains(document.activeElement);
    const scheduleHide = (): void => {
        if (pinned()) return;
        cancelHide();
        hideTimer = window.setTimeout(() => {
            if (pinned() || typingInside()) return;
            setMode("ball");
            setRosterOpen(false);
        }, HOVER_HIDE_MS);
    };
    onCleanup(cancelHide);
    /**
     * 靠近（把手 hover）→ 开面板；已有面板则只是取消关闭。
     *
     * ⚠️ 加 120ms 小延迟，两个理由：
     * ① 球一 hover 就卸载（面板把它盖住）⇒ 「靠近变亮」（§39.2 ④）**根本看不到**；
     *    留出这个窗口，CSS `hover:opacity-100` 才有可观测的时间；
     * ② 鼠标快速划过右缘时不误开面板。
     */
    let openTimer: number | undefined;
    const hoverOpen = (): void => {
        cancelHide();
        if (mode() !== "ball") return;
        if (openTimer !== undefined) window.clearTimeout(openTimer);
        openTimer = window.setTimeout(() => {
            openTimer = undefined;
            setMode("normal");
        }, 120);
    };
    /** 离开球：既取消"即将打开"，也排"延迟关闭" */
    const hoverAway = (): void => {
        if (openTimer !== undefined) {
            window.clearTimeout(openTimer);
            openTimer = undefined;
        }
        scheduleHide();
    };
    onCleanup(() => {
        if (openTimer !== undefined) window.clearTimeout(openTimer);
    });
    /** 点把手 = 固定态切换（常驻 / 恢复 hover 开关）——§39.2 ④ 的逃生口 */
    const pinToggle = (): void => {
        cancelHide();
        if (mode() === "ball") {
            setMode("normal");
            setPinned(true);
            return;
        }
        setPinned((v) => !v);
    };
    /** 成员抽屉开关（左缘把手与 viewbar 按钮共用） */
    const toggleRoster = (): void => {
        cancelHide();
        setRosterOpen((v) => !v);
    };
    /** 三级披露：打开人物编辑半截页（复用 `PersonaDrawer`） */
    const openPersona = (personaId: string | null | undefined): void => {
        if (!personaId) return;
        setPersonaTarget(personaId);
        setPersonaOpen(true);
    };

    const setFocus = async (m: RoomMember | null): Promise<void> => {
        const id = roomId();
        if (!id) return;
        try {
            setRoom(await diyService.diy.room.focus({ id, member: m ? m.id : undefined }));
        } catch (e) {
            notificationStore.addToast("error", `设当前接受者失败：${msgOf(e)}`);
        }
    };

    const insertAddress = (name: string): void => {
        setInput((prev) => {
            const stripped = prev.replace(/^\s*(@[A-Za-z0-9_.\-/:]+\s*)+/, "");
            return `@${name} ${stripped}`;
        });
    };

    const invite = async (personaId: string): Promise<void> => {
        const id = roomId();
        if (!id || !personaId) return;
        try {
            const r = await diyService.diy.room.invite({ id, persona: personaId, task: undefined, role: undefined });
            notificationStore.addToast(
                "info",
                `已邀请 ${r.member.name}（${r.createdTask ? "新建影子任务" : "复用已有任务"} ${r.taskUri}）`,
            );
            await loadRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `邀请失败：${msgOf(e)}`);
        }
    };

    const removeMember = async (m: RoomMember): Promise<void> => {
        const id = roomId();
        if (!id) return;
        try {
            setRoom(await diyService.diy.room.removeMember({ id, member: m.id }));
            notificationStore.addToast("info", `已把 ${m.name} 移出房间（影子任务保留）`);
            await loadRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `移出失败：${msgOf(e)}`);
        }
    };

    const send = async (): Promise<void> => {
        const id = roomId();
        const text = input();
        if (!id || !text.trim()) return;
        setPendingPosts((n) => n + 1);
        setErr(null);
        setInput(""); // 立刻清空：post 流挂到所有收件人跑完（可能几十秒），不能让输入框跟着卡住
        try {
            const stream = await diyService.diy.room.post({ id, text });
            for await (const raw of stream) {
                const ev = JSON.parse(raw) as RoomEvent;
                // **按 id 覆盖**（同一条 say 会随投递状态变化被推多次：排队中 → 投递中 → 已投递）
                setEvents((prev) => {
                    const i = prev.findIndex((x) => x.id === ev.id);
                    if (i < 0) return [...prev, ev];
                    const copy = [...prev];
                    copy[i] = ev;
                    return copy;
                });
                // 自己发言：无论刚才在哪儿，都要看见自己这句与它的回复（`force`）
                queueMicrotask(() => {
                    if (streamRef) pinBottom(streamRef, true);
                });
            }
        } catch (e) {
            setInput(text);
            setErr(`投递失败：${msgOf(e)}`);
        } finally {
            setPendingPosts((n) => n - 1);
            await loadRoom(id, { soft: true });
        }
    };

    return (
        <>
            {/* ── 球态（##377 第 13 刀 ④）：**屏幕最右缘**（nav 式）—— 更小 · 低透明度（不遮下方文字）·
                   靠近变亮；**hover 打开 · 移走关闭**（带滞回）；**点击 = 固定常驻**（逃生口） ── */}
            <Show when={mode() === "ball"}>
                <button
                    class="fixed right-0 top-1/3 z-40 rounded-l-lg border border-r-0 border-[var(--diy-overlay-edge)] bg-[var(--diy-surface-overlay)] px-1 py-2 opacity-40 shadow-lg transition-opacity hover:opacity-100"
                    title="靠近打开侧边栏助手（移走自动收起）；要常驻请用面板里的 📌"
                    onMouseEnter={hoverOpen}
                    onMouseLeave={hoverAway}
                    data-sidebar-open
                >
                    <span class="text-base">💬</span>
                    <div class="text-caption [writing-mode:vertical-rl]">助手</div>
                </button>
            </Show>

            {/* ── 普通态 / 最大化态：同一块面板（差别 = 宽度 + 有没有右侧成员栏） ── */}
            <Show when={mode() !== "ball"}>
                <div
                    class="fixed right-0 top-0 z-40 h-full flex flex-col border-l [border-left-color:var(--diy-overlay-edge)] bg-[var(--diy-surface-overlay)] shadow-2xl"
                    style={{ width: `${panelW()}px`, "max-width": "96vw" }}
                    ref={(el) => (panelRef = el)}
                    onMouseEnter={cancelHide}
                    onMouseLeave={scheduleHide}
                    data-sidebar-room
                    data-sidebar-mode={mode()}
                    data-sidebar-pinned={pinned() ? "true" : "false"}
                >
                    {/* 左缘拖宽条（复用既有模式；双击复位） */}
                    <div
                        class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
                        title="拖动调整宽度（双击复位）"
                        onMouseDown={onGripDown}
                        onDblClick={resetW}
                        data-sidebar-grip
                    />

                    {/* viewbar：一条细条 = 房间名 + **单个**切换按钮（用户要求"删除输入框以上的所有页面元素"） */}
                    <div
                        class={`flex items-center gap-2 px-2 ${VIEW_BAR_H} border-b [border-bottom-color:var(--diy-overlay-edge)] bg-[var(--diy-surface-inset)] shrink-0`}
                        data-sidebar-viewbar
                    >
                        <span class="text-body shrink-0">💬</span>
                        <span class="text-body font-medium truncate" title={roomId() ?? ""}>
                            {room()?.title || "侧边栏"}
                        </span>
                        <span class="badge badge-xs badge-ghost shrink-0">
                            {room()?.members.length ?? 0} 人
                        </span>
                        {/* view 级操作（##166 §38.3）：room 的「当前接受者」在这里，不在成员行内 */}
                        <span class="text-caption opacity-60 truncate" data-sidebar-focus>
                            接受者 {focusMember()?.name ?? "（无）"}
                        </span>
                        <Show when={focusMember()}>
                            <button
                                class="btn btn-xs btn-ghost shrink-0"
                                title="清空当前接受者（之后不写 @ 的发言 = 笔记）"
                                onClick={() => void setFocus(null)}
                                data-sidebar-focus-clear
                            >
                                清空
                            </button>
                        </Show>
                        <div class="flex-1" />
                        <button
                            class="btn btn-xs btn-ghost"
                            title={rosterOpen() ? "收起成员列表" : "展开成员列表（左缘抽屉）"}
                            onClick={toggleRoster}
                            data-sidebar-toggle
                        >
                            {rosterOpen() ? "⤡ 收起成员" : "⤢ 成员"}
                        </button>
                        <button
                            class="btn btn-xs btn-ghost"
                            title={
                                pinned()
                                    ? "取消固定（恢复「移走自动收起」）"
                                    : "固定常驻（不随鼠标移走关闭）"
                            }
                            onClick={() => setPinned((v) => !v)}
                            data-sidebar-pin
                        >
                            {pinned() ? "📌 已固定" : "📌"}
                        </button>
                    </div>

                    {/* 主体：只有会话区 —— 成员列表在**面板左缘的抽屉**里（下方），不挤压它 */}
                    <div class="flex-1 flex min-h-0">
                        <div class="flex-1 flex flex-col min-w-0">
                            {/* 事件流（外层 relative：「回到最新」按钮的立足点，不随内容滚动） */}
                            <div class="relative flex-1 min-h-0 flex flex-col">
                            <div
                                class="flex-1 overflow-auto px-2.5 py-1.5 space-y-1.5"
                                ref={(el) => {
                                    streamRef = el;
                                    setFollow({ ...streamFollowInit }); // 打开面板：从最新看起
                                    if (el) queueMicrotask(() => pinBottom(el, true));
                                }}
                                onScroll={(e) => {
                                    // ⚠️ 跟随态只由**人滚的**决定：钉底带出来的 scroll 事件不算
                                    // （判据在 lib/chat-scroll.onStreamScroll）
                                    const el = e.currentTarget;
                                    setFollow(
                                        onStreamScroll(followNow(), {
                                            scrollTop: el.scrollTop,
                                            scrollHeight: el.scrollHeight,
                                            clientHeight: el.clientHeight,
                                        }),
                                    );
                                }}
                                data-sidebar-events
                            >
                                <Show when={events().length === 0}>
                                    <div class="text-caption opacity-50">
                                        还没有发言。最大化后点成员卡的 @ 寻址，或直接打字（投给当前接受者）。
                                    </div>
                                </Show>
                                <For each={events()}>
                                    {(e) => {
                                        const mine = () => e.author === human()?.id;
                                        const author = () => room()?.members.find((m) => m.id === e.author);
                                        const st = () => turns()[e.id];
                                        const isFolded = () => folded()[e.id] === true;
                                        createEffect(() => {
                                            if (e.kind !== "reply" || !e.ref || st()) return;
                                            void loadTurn(e.id);
                                        });
                                        return (
                                            <div
                                                class={`flex ${mine() ? "justify-end" : "justify-start"}`}
                                                data-sidebar-event
                                                data-sidebar-kind={e.kind}
                                                data-sidebar-author={e.author}
                                                data-sidebar-delivered={e.delivered ? "true" : "false"}
                                            >
                                                <div class="max-w-[92%] flex flex-col">
                                                    <Show when={!mine()}>
                                                        <div class="flex items-center gap-1.5 mb-0.5">
                                                            <div
                                                                class="w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0"
                                                                style={{
                                                                    background: `${colorOf(e.author)}33`,
                                                                    border: `1px solid ${colorOf(e.author)}`,
                                                                }}
                                                                data-sidebar-avatar={e.author}
                                                            >
                                                                {avatarOf(e.author)}
                                                            </div>
                                                            <span
                                                                class="text-caption font-medium"
                                                                style={{ color: colorOf(e.author) }}
                                                            >
                                                                {author()?.name ?? shortName(e.author)}
                                                            </span>
                                                            <span class="text-caption opacity-40">{hms(e.ts)}</span>
                                                            <Show when={e.to.length > 0}>
                                                                <span class="text-caption opacity-40">
                                                                    → {e.to.map((t) => memberName(room(), t)).join(" / ")}
                                                                </span>
                                                            </Show>
                                                        </div>
                                                    </Show>
                                                    <div
                                                        class={`rounded-lg px-3 py-1.5 text-prose whitespace-pre-wrap ${
                                                            e.kind === "say" ? "bg-primary/15" : "bg-base-200"
                                                        }`}
                                                    >
                                                        {e.text || <span class="opacity-50">（无正文）</span>}
                                                    </div>
                                                    {/* 笔记（##166 §38.2）：**中性**标记 —— 不是投递失败，也不该像故障 */}
                                                    <Show when={e.routing === "note"}>
                                                        <div
                                                            class="mt-0.5 flex items-center gap-1"
                                                            data-sidebar-note={e.id}
                                                        >
                                                            <span class="badge badge-xs badge-ghost opacity-70">
                                                                笔记
                                                            </span>
                                                            <span class="text-caption opacity-40">
                                                                不投递，只进房间历史
                                                            </span>
                                                        </div>
                                                    </Show>
                                                    <Show when={(e.deliveries?.length ?? 0) > 0}>
                                                        <div class="flex flex-wrap gap-1 mt-0.5">
                                                            <For each={e.deliveries}>
                                                                {(d) => (
                                                                    <span
                                                                        class={`badge badge-xs ${statusClass(d.status)}`}
                                                                        title={d.error ?? ""}
                                                                        data-sidebar-delivery={`${e.id}:${d.memberId}`}
                                                                        data-sidebar-status={d.status}
                                                                    >
                                                                        {memberName(room(), d.memberId)} · {deliveryStatusText(d.status)}
                                                                    </span>
                                                                )}
                                                            </For>
                                                        </div>
                                                    </Show>
                                                    <Show when={e.error}>
                                                        <div class="text-caption text-error mt-0.5" data-sidebar-undelivered>
                                                            {e.kind === "say" ? "未投递：" : ""}
                                                            {e.error}
                                                        </div>
                                                    </Show>
                                                    {/* 过程进度：同一份数据（成员会话的那一轮）、同一套渲染（TurnView） */}
                                                    <Show when={e.kind === "reply" && e.ref}>
                                                        <div
                                                            class="mt-0.5 rounded-lg border border-base-300 bg-base-100/60"
                                                            data-sidebar-progress={e.id}
                                                        >
                                                            <button
                                                                class="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-caption"
                                                                onClick={() =>
                                                                    setFolded((p) => ({ ...p, [e.id]: !isFolded() }))
                                                                }
                                                                data-sidebar-progress-toggle={e.id}
                                                            >
                                                                <span class="opacity-60">{isFolded() ? "▸" : "▾"}</span>
                                                                <span>过程进度</span>
                                                                <span class="opacity-50">
                                                                    {shortName(e.author)} · {st()?.turnId ?? e.ref!.turnId}
                                                                </span>
                                                                <Show when={st()?.live}>
                                                                    <span class="badge badge-xs badge-info">直播中</span>
                                                                </Show>
                                                            </button>
                                                            <Show when={!isFolded()}>
                                                                <div class="px-2 pb-1.5">
                                                                    <Show when={st()?.error}>
                                                                        <div class="text-caption text-error">{st()!.error}</div>
                                                                    </Show>
                                                                    <Show when={!st()}>
                                                                        <div class="text-caption opacity-60">正在取这一轮…</div>
                                                                    </Show>
                                                                    <Show when={st()?.turn}>
                                                                        <ChatView
                                                                            source={{
                                                                                trees: () => {
                                                                                    const t = st()?.turn;
                                                                                    return t ? [t] : [];
                                                                                },
                                                                                live: () => st()?.live === true,
                                                                            }}
                                                                        >
                                                                            <TurnView
                                                                                turnId={e.ref!.turnId}
                                                                                pin={pin()}
                                                                                level={2}
                                                                                histOpen={true}
                                                                                onCycle={() => undefined}
                                                                                conclusionLines={3}
                                                                                onResizeLines={() => undefined}
                                                                                onToggle={(bid, force) =>
                                                                                    setPin((p) => ({ ...p, [bid]: force ?? !p[bid] }))
                                                                                }
                                                                                onFull={() => undefined}
                                                                                liveTurnId={st()?.live ? e.ref!.turnId : null}
                                                                                md={true}
                                                                                usageHover={null}
                                                                                onHoverUsage={() => undefined}
                                                                                onHoverEndUsage={() => undefined}
                                                                                usageDetail={null}
                                                                                onDetailUsage={() => undefined}
                                                                            />
                                                                        </ChatView>
                                                                    </Show>
                                                                </div>
                                                            </Show>
                                                        </div>
                                                    </Show>
                                                </div>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                                {/* 上翻阅读时绝不打扰，但要给一条「回去」的路 —— 否则新消息会静默堆积 */}
                                <Show when={!stick()}>
                                    <button
                                        class="absolute bottom-2 right-3 z-10 btn btn-xs"
                                        onClick={() => {
                                            if (streamRef) pinBottom(streamRef, true);
                                        }}
                                        data-sidebar-tolatest
                                    >
                                        ↓ 回到最新
                                    </button>
                                </Show>
                            </div>

                            {/* 输入区：**任务对话那台编辑器**（MdEditor，同一份实现）+ 底部工具条同框内 */}
                            <div class="border-t p-2 shrink-0">
                                <Show when={err()}>
                                    <div class="text-caption text-error mb-1" data-sidebar-error>
                                        {err()}
                                    </div>
                                </Show>
                                <Show when={badLines() > 0}>
                                    <div class="text-caption text-warning mb-1">
                                        事件流有 {badLines()} 行读不出来（已跳过）
                                    </div>
                                </Show>
                                <div
                                    class="rounded-field border border-base-content/20 bg-[var(--diy-surface-inset)] transition-colors focus-within:border-base-content relative flex flex-col"
                                    style={{ "max-height": "42vh" }}
                                    data-sidebar-input
                                >
                                    <div class="min-h-0 flex-auto overflow-auto px-2 pt-1.5">
                                        <MdEditor
                                            value={input()}
                                            editable
                                            onChange={(v) => setInput(v)}
                                            onEnter={() => void send()}
                                            completions={completions()}
                                            mention
                                            wrap
                                            embedded
                                        />
                                    </div>
                                    <div class="flex shrink-0 items-center gap-2 px-2 py-1.5 text-body">
                                        <span class="text-caption opacity-70 truncate" data-sidebar-hint>
                                            {hint()}
                                        </span>
                                        <div class="flex-1" />
                                        <Show when={busy()}>
                                            <span class="text-caption opacity-70">投递中…</span>
                                        </Show>
                                        <button
                                            class="btn btn-xs btn-ghost"
                                            onClick={() => insertAddress("all")}
                                            data-sidebar-all
                                        >
                                            @all
                                        </button>
                                        <button
                                            class="btn btn-sm btn-primary"
                                            disabled={!input().trim() || !roomId()}
                                            onClick={() => void send()}
                                            data-sidebar-send
                                        >
                                            {busy() ? "发送（会排队）" : "发送"}
                                        </button>
                                    </div>
                                </div>
                                <div class="text-caption opacity-50 mt-1">
                                    回车发送 / Shift+回车换行 · 不写 @ 且无接受者时 = 笔记（只进房间历史）
                                </div>
                            </div>
                        </div>

                    </div>
                </div>

                {/* ② 成员列表：**面板左缘的窄把手**（≤ 球宽 2/3）→ **向左**拉出抽屉。
                    方案 (b)（§39.2 ② 待决 102 先做这条）：抽屉**贴面板左缘**、覆盖主内容区方向，
                    **不挤压会话区**（会话区宽度 = 拖出来的宽度，与成员列表无关）。 */}
                <button
                    class={`fixed top-1/3 z-50 rounded-l-lg border border-r-0 border-[var(--diy-overlay-edge)] bg-[var(--diy-surface-raised)] shadow-lg transition-opacity ${
                        rosterOpen() ? "" : "opacity-60 hover:opacity-100"
                    }`}
                    style={{ right: `${panelW()}px`, width: `${ROSTER_HANDLE_W}px` }}
                    title={rosterOpen() ? "收起成员列表" : "展开成员列表（向左拉出）"}
                    onClick={toggleRoster}
                    data-sidebar-roster-handle
                >
                    <div class="text-caption py-2 [writing-mode:vertical-rl]">成员</div>
                </button>
                <Show when={rosterOpen()}>
                    <div
                        class="fixed top-0 z-40 h-full border-l bg-[var(--diy-surface-raised)] shadow-2xl [border-left-color:var(--diy-overlay-edge)]"
                        style={{ right: `${panelW()}px`, width: `${ROSTER_W}px` }}
                        onMouseEnter={cancelHide}
                        onMouseLeave={scheduleHide}
                        data-sidebar-roster-drawer
                    >
                        <RoomRoster
                            class="w-full h-full"
                            room={room()}
                            roster={roster()}
                            onFocus={(m) => void setFocus(m)}
                            onInvite={invite}
                            onRemove={(m) => void removeMember(m)}
                            onAddress={insertAddress}
                            onPersona={(m) => openPersona(m.persona)}
                        />
                    </div>
                </Show>
            </Show>

            {/* 三级披露（§39.2 ③）：点头像 → 人物编辑半截页（**复用** `PersonaDrawer`，不新写一套）；
                待决 105：关闭即重取 roster（简单可靠，不做增量订阅） */}
            <PersonaDrawer
                open={personaOpen()}
                initialPersona={personaTarget()}
                onClose={() => {
                    setPersonaOpen(false);
                    const id = roomId();
                    if (id) void loadRoom(id, { soft: true });
                }}
            />
        </>
    );
}

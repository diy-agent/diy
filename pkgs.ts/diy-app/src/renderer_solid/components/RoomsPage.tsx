/**
 * RoomsPage — 导航「房间」页（##377 最小切片 / 设计真源 ##166 §28）。
 *
 * 布局（三栏）：左 = 房间列表 · 中 = 对话流 · **右 = 成员栏**（把房间里的人列出来）。
 *
 * 三条口径（全部来自设计，不在这里重新论证）：
 *   · room ≠ session：本页只画「成员栏 + 事件流 + 输入框」，任何成员的历史都不在这里；
 *   · 成员各自独立会话：agent 成员的 backend 绑一个 task —— 页面只显示"它是谁 / 绑哪个任务"，
 *     真跑的那一轮在**它自己的任务会话**里（证据看那个任务的对话/ops 流）；
 *   · 必须 @：`@X` 显式（可连写多个 / `@all` 群发）覆盖「当前接受者」`focus`；
 *     两者都没有 ⇒ 只落盘 + **显式标「未投递」**（绝不静默丢弃）。
 *
 * 判据（`parseAddress` / `resolveRecipients` / `deliveryHint` / 头像 / 配色）与 main 侧**同一份实现**
 * （`shared/room.ts`）—— UI 的"将投递给谁"就是服务端真会投给谁，不存在两套 if。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { personaStore } from "../store/personaStore";
import {
    deliveryHint,
    deliveryStatusText,
    isAllAddress,
    memberAvatar,
    memberColor,
    originLabel,
    memberName,
    orderedMembers,
    parseAddress,
    resolveMember,
    resolveRecipients,
    shortName,
    type DeliveryStatus,
    type Room,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";
// 进度消息（##166 §28.7 A）：**复用任务对话那套块渲染**，不为 room 另写一套 ——
// `TurnView` + `ChatView` 就是任务对话页在用的同两个东西，这里只是把数据源换成"成员会话的那一轮"。
import { ChatView, TurnView } from "./LocalChatPage";
import { onStreamScroll, pinnedTo, streamFollowInit, type StreamFollowState } from "../lib/chat-scroll";
import type { BlockNode } from "../../main/services/local-blocks";

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 一条 reply 的进度快照（`room.turn` 的返回 + 取它的时刻） */
interface TurnState {
    /** 这一轮的块树（null = 成员会话里已找不到它） */
    turn: BlockNode | null;
    taskUri: string;
    turnId: string;
    /** 该成员此刻是否正有轮次在跑 */
    live: boolean;
    /** 取失败的原因（人话） */
    error?: string;
}

/** 一行事件的时间（HH:MM:SS；解析不出就不显示，绝不用渲染时刻顶替） */
function hms(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 成员绑的会话（只有 agent 有；人没有 backend） */
function taskOf(m: RoomMember | undefined): string {
    if (m?.backend?.type !== "task") return "";
    return m.backend.data.taskUri ?? "";
}

/** 投递状态 → daisyUI 徽章配色（一处真源） */
function statusClass(s: DeliveryStatus): string {
    switch (s) {
        case "ok":
            return "badge-success";
        case "failed":
            return "badge-error";
        case "running":
            return "badge-info";
        case "queued":
            return "badge-warning";
        case "skipped":
            return "badge-ghost";
    }
}

interface RoomSummary {
    id: string;
    title?: string;
    focus: string | null;
    members: number;
    last?: string;
}

/** 成员 L1 状态（`diy.room.roster` 的一行；**字段真源在 main** —— 这里只做显示，不推断） */
interface RosterMemberL1 {
    memberId: string;
    isHuman: boolean;
    queued: number;
    running: number;
    action: { kind: string; label: string } | null;
    entry: {
        turn: { turnId: string; steps: number; startedAt: string; state: string } | null;
        turnCount: number;
        totalSteps: number;
    } | null;
}

/** 从 ISO 起始时刻算「已用多久」：**起点由服务端给**，滴答在本地（不必每秒问服务端） */
const elapsedText = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
};

export function RoomsPage() {
    const [rooms, setRooms] = createSignal<RoomSummary[]>([]);
    const [roomId, setRoomId] = createSignal<string | null>(null);
    const [room, setRoom] = createSignal<Room | null>(null);
    const [events, setEvents] = createSignal<RoomEvent[]>([]);
    const [badLines, setBadLines] = createSignal(0);
    const [err, setErr] = createSignal<string | null>(null);
    /**
     * 在飞的 post 条数（>0 = 有投递在跑）。
     *
     * 用**计数**不是布尔：允许连发（同一成员的后续消息在服务端排队 —— 用户口径「单个 agent 串行」），
     * 两条流同时在飞时布尔会被"先回来的那条"提前置 false。
     */
    const [pendingPosts, setPendingPosts] = createSignal(0);
    const busy = () => pendingPosts() > 0;
    const [input, setInput] = createSignal("");
    /**
     * 每条 `reply` 的**进度**（##166 §28.7 A）—— key = 事件 id。
     *
     * 这里只存"取回来的那一轮"（块树）与它是否还在跑；真进度**不在这里**（在成员会话的 ops 流里），
     * 本页只是它的一扇窗（room 不留进度数据 —— §28.7 A / §28.6 待决 74）。
     */
    /**
     * 成员的**此刻状态**（L1；##166 第三轮口径第 3 条）—— **服务端给的，UI 不猜**。
     *
     * 随房间轮询（2.5s）一起刷；读失败只是这一块空着，不打断房间（L1 是附加信息）。
     */
    const [roster, setRoster] = createSignal<RosterMemberL1[]>([]);
    const [turns, setTurns] = createSignal<Record<string, TurnState>>({});
    /** 展开态（缺省展开：用户要的就是"看得见过程"）；显式收起过的记 false */
    const [folded, setFolded] = createSignal<Record<string, boolean>>({});
    /** 块的开合（TurnView 的 pin）：room 里点开合也照常能用（与任务对话同一套交互） */
    const [pin, setPin] = createSignal<Record<string, boolean>>({});
    const [newId, setNewId] = createSignal("");
    const [newTitle, setNewTitle] = createSignal("");
    const [memberName_, setMemberName_] = createSignal("");
    const [memberTask, setMemberTask] = createSignal("");
    /**
     * 邀请面板（##166 §28.K ② / §28.7 F ②）：**从人物选**（不列 task）。
     *
     * 「人物」专指 agent 人格（`personas.yaml`）—— 人成员不走这条路（人 = 页面操作者本人，无 backend）。
     */
    const [invitePersona, setInvitePersona] = createSignal("");
    /** 高级入口（手填名字 + 绑**已有** task）默认收起 —— §28.K 待拍 19：长留但不暴露 */
    const [advanced, setAdvanced] = createSignal(false);
    let streamRef: HTMLDivElement | undefined;

    /**
     * 事件流跟随态（##377 第 19 刀，与侧边栏同构）：**贴底才跟随**。
     * 原先取数后无条件钉底，而取数是 2.5s 一次的轮询 ⇒ 用户往上翻就被拽回底部。
     * 判据在 `lib/chat-scroll.onStreamScroll`（含"程序化滚动也会发 scroll 事件"这一坑）。
     */
    const [stick, setStick] = createSignal(true);
    let progWrite: number | null = null;
    const followNow = (): StreamFollowState => ({ stick: stick(), progWrite });
    const setFollow = (s: StreamFollowState): void => {
        progWrite = s.progWrite;
        if (s.stick !== stick()) setStick(s.stick);
    };
    /** 唯一的程序化滚动出口；`force` = 用户明确意图（自己发言 / 打开房间 / 点「回到最新」） */
    const pinBottom = (el: HTMLDivElement, force = false): void => {
        if (!force && !stick()) return;
        el.scrollTop = el.scrollHeight;
        setFollow(pinnedTo(el.scrollTop));
    };

    /** 成员展示顺序（人先、agent 后）—— 右栏顺序与头像位次同一份 */
    const ordered = createMemo(() => orderedMembers(room()));
    const human = createMemo(() => room()?.members.find((m) => m.kind === "human") ?? null);
    const focusMember = createMemo(() => room()?.members.find((m) => m.id === room()?.focus) ?? null);

    const avatarOf = (id: string): string => {
        const list = ordered();
        const i = list.findIndex((m) => m.id === id);
        const m = i >= 0 ? list[i]! : { id };
        return memberAvatar(m, i);
    };
    const colorOf = (id: string): string => {
        const m = room()?.members.find((x) => x.id === id) ?? { id };
        return memberColor(m);
    };

    /** 输入框里这句将投给谁（与服务端同一份判据） */
    const hint = createMemo(() => {
        const r = room();
        if (!r) return "";
        const addr = parseAddress(input());
        const explicit = addr.tos.map((t) => (isAllAddress(t) ? "all" : resolveMember(r, t)));
        // self = 人成员（`@` 自己 = 笔记，##166 §38.2）—— 与服务端 `postToRoom` 同一份判据
        const { recipients, routing } = resolveRecipients(explicit, r.focus, r.members, human()?.id);
        return deliveryHint(recipients, r, routing);
    });

    const refreshRooms = async (): Promise<void> => {
        try {
            const r = await diyService.diy.room.list({});
            setRooms(r.rooms);
        } catch (e) {
            setErr(`读房间列表失败：${msgOf(e)}`);
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

    /**
     * 取成员的 L1 状态（此刻在干什么 / 第几步 / 多久 / 排几条队）。
     *
     * 口径（##166 第三轮第 3 条）：**服务端能给，不靠 UI 猜** —— 本函数只是把 main 合成的
     * 那一行显示出来；"在跑吗 / 在做什么 / 多久"全部来自服务端（会话注册表 + 未闭合块 + 投递链）。
     */
    const loadRoster = async (id: string): Promise<void> => {
        try {
            const r = await diyService.diy.room.roster({ id });
            setRoster(r.members as RosterMemberL1[]);
        } catch {
            /* L1 是附加信息：读不到就让状态行空着（下一轮还会再试） */
        }
    };

    const rosterOf = (id: string): RosterMemberL1 | undefined => roster().find((m) => m.memberId === id);

    /**
     * 取一条 reply 的进度（该成员会话的那一轮）。**不新造数据源** ——
     * main 侧只是把 `ref = { memberUri, turnId }` 指向的那一轮从成员会话里切出来。
     */
    const loadTurn = async (eventId: string, opts: { soft?: boolean } = {}): Promise<void> => {
        const id = roomId();
        if (!id) return;
        try {
            const r = await diyService.diy.room.turn({ id, event: eventId, member: undefined, turn: undefined });
            setTurns((prev) => ({
                ...prev,
                [eventId]: {
                    turn: r.turn as BlockNode | null,
                    taskUri: r.taskUri,
                    turnId: r.turnId,
                    live: r.live,
                },
            }));
        } catch (e) {
            if (opts.soft) return; // 轮询里的失败不打断（下一轮还会再试）
            setTurns((prev) => ({ ...prev, [eventId]: { turn: null, taskUri: "", turnId: "", live: false, error: msgOf(e) } }));
        }
    };

    const openRoom = async (id: string): Promise<void> => {
        setRoomId(id);
        await loadRoom(id);
    };

    const createRoom = async (): Promise<void> => {
        const id = newId().trim();
        if (!id) return;
        try {
            await diyService.diy.room.create({
                id,
                title: newTitle().trim() || undefined,
                human: "chen56",
            });
            setNewId("");
            setNewTitle("");
            await refreshRooms();
            await openRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `建房间失败：${msgOf(e)}`);
        }
    };

    /**
     * 已在房间的人物（护栏，##166 §28.7 F）：**同一 backend 不得挂两个人物**（A 帽子，§27 已否）。
     *
     * 注：**同一人物可进多个 room**（那是允许的）—— 这里禁的是"同一个房间里同一个人物再来一个"，
     * 因为成员名是 `@` 寻址的键，重名会让寻址有歧义（`resolveMember` 取第一个）。
     */
    const invitedPersonas = createMemo(
        () => new Set((room()?.members ?? []).map((m) => m.persona).filter((x): x is string => !!x)),
    );

    /**
     * 人物清单 —— **直接用 `personaStore`**（人物管理页 / 任务详情面板同一份缓存），
     * 不自己再拉一遍：清单是 `agent.persona.list` 的一次全库扫描（带引用计数），多拉一份纯浪费。
     */
    const personaOptions = createMemo(() => personaStore.personas.map((p) => ({ id: p.id, name: p.name })));

    /** 邀请（主路径）：选人物 → 服务端配 backend（缺省自动建影子 task 作它的会话） */
    const invite = async (): Promise<void> => {
        const id = roomId();
        const pid = invitePersona();
        if (!id || !pid) return;
        try {
            const r = await diyService.diy.room.invite({ id, persona: pid, task: undefined, role: undefined });
            notificationStore.addToast(
                "info",
                `已邀请 ${r.member.name}（${r.createdTask ? "新建影子任务" : "复用已有任务"} ${r.taskUri}）`,
            );
            await loadRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `邀请失败：${msgOf(e)}`);
        }
    };

    const addMember = async (): Promise<void> => {
        const id = roomId();
        const name = memberName_().trim();
        if (!id || !name) return;
        if (!memberTask().trim()) {
            notificationStore.addToast("error", "agent 成员必须绑一个任务作为它的会话（backend 不能空）");
            return;
        }
        try {
            await diyService.diy.room.addMember({
                id,
                name,
                task: memberTask().trim(),
                persona: undefined,
                role: undefined,
            });
            setMemberName_("");
            setMemberTask("");
            await loadRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `加成员失败：${msgOf(e)}`);
        }
    };

    const setFocus = async (m: RoomMember | null): Promise<void> => {
        const id = roomId();
        if (!id) return;
        try {
            const r = await diyService.diy.room.focus({ id, member: m ? m.id : undefined });
            setRoom(r);
        } catch (e) {
            notificationStore.addToast("error", `设当前接受者失败：${msgOf(e)}`);
        }
    };

    /** 把 `@名字 ` 塞到输入框开头（已有 @ 前缀就替换掉，避免 `@dev @review` 手打） */
    const insertAddress = (name: string): void => {
        setInput((prev) => {
            const stripped = prev.replace(/^\s*(@[A-Za-z0-9_.\-/:]+\s*)+/, "");
            return `@${name} ${stripped}`;
        });
    };

    const send = async (): Promise<void> => {
        const id = roomId();
        const text = input();
        if (!id || !text.trim()) return;
        setPendingPosts((n) => n + 1);
        setErr(null);
        setInput(""); // 立刻清空：post 流会一直挂到所有收件人跑完（可能几十秒），不能让输入框跟着卡住
        // 自己的发言：**发送瞬间**强制回到底部（用户的明确意图，只此一次）——
        // 投递流之后的事件不再 force（见下方 for-await 内的注释）
        if (streamRef) pinBottom(streamRef, true);
        try {
            // serverStream：先拿 handle，再迭代（StreamHandle 即 AsyncIterable）
            const stream = await diyService.diy.room.post({ id, text });
            for await (const raw of stream) {
                // serverStream 的 yield 是 JSONL 字符串（RPC 层统一形状）—— 这里解回事件对象
                const ev = JSON.parse(raw) as RoomEvent;
                // **按 id 覆盖**（不是"有就跳过"）：同一条 say 会在流里被推多次 ——
                // 每次投递状态变化（排队中 → 投递中 → 已投递）都是一份新的快照。
                setEvents((prev) => {
                    const i = prev.findIndex((x) => x.id === ev.id);
                    if (i < 0) return [...prev, ev];
                    const copy = [...prev];
                    copy[i] = ev;
                    return copy;
                });
                // 事件到达后**只在贴底时**跟随（##377 第 20 刀）。
                // 原来这里是 `force`（无视阅读位置）⇒ 一次投递会推多条事件（say → 排队 → 投递中 →
                // 回复），用户趁 agent 干活时上翻看历史，会被下一条事件拽回底部 —— 与"无法翻越"同一个病。
                // 自己的发言已在 `send` 开头 force 钉过一次；此后尊重阅读位置。
                queueMicrotask(() => {
                    if (streamRef) pinBottom(streamRef);
                });
            }
        } catch (e) {
            setInput(text); // 投递失败：把这句还给输入框（别让人白打）
            setErr(`投递失败：${msgOf(e)}`);
            notificationStore.addToast("error", `房间投递失败：${msgOf(e)}`);
        } finally {
            setPendingPosts((n) => n - 1);
            await loadRoom(id, { soft: true });
        }
    };

    onMount(() => {
        void refreshRooms();
        void personaStore.load();
    });

    // 轻量轮询：别的窗口 / CLI 往房间写的发言、以及**排队中/投递中**的状态变化都要能看见
    // （本切片不做推送通道，写进开发日志）
    onMount(() => {
        const t = setInterval(() => {
            const id = roomId();
            if (!id) return;
            // 不做可见性判断：窗口在后台时"排队中 → 已投递"的变化照样要能看见（room.get 只是读文件）
            void loadRoom(id, { soft: true });
            void refreshRooms();
            // 正在跑的那几轮：进度还在长，跟着刷（已完成的不再取 —— 它不会变了）
            for (const [eid, st] of Object.entries(turns())) if (st.live) void loadTurn(eid, { soft: true });
        }, 2500);
        onCleanup(() => clearInterval(t));
    });

    return (
        <div class="flex h-full min-h-0" data-room-page>
            {/* ── 左：房间列表 ───────────────────────────────── */}
            <div class="w-56 shrink-0 border-r flex flex-col min-h-0">
                <div class="px-3 py-2 border-b shrink-0">
                    <div class="text-caption opacity-70 mb-1">房间</div>
                    <input
                        class="input input-xs input-bordered w-full mb-1"
                        placeholder="房间 id"
                        value={newId()}
                        onInput={(e) => setNewId(e.currentTarget.value)}
                        data-room-new-id
                    />
                    <input
                        class="input input-xs input-bordered w-full mb-1"
                        placeholder="标题（可选）"
                        value={newTitle()}
                        onInput={(e) => setNewTitle(e.currentTarget.value)}
                    />
                    <button class="btn btn-xs w-full" onClick={() => void createRoom()} data-room-create>
                        新建房间
                    </button>
                </div>
                <div class="flex-1 overflow-auto">
                    <For each={rooms()}>
                        {(r) => (
                            <button
                                class={`w-full text-left px-3 py-1.5 text-sm hover:bg-base-200 ${
                                    roomId() === r.id ? "bg-base-200 font-medium" : ""
                                }`}
                                onClick={() => void openRoom(r.id)}
                                data-room-item={r.id}
                            >
                                <div class="truncate">{r.title || r.id}</div>
                                <div class="text-caption opacity-60 truncate">
                                    {r.members} 名成员{r.last ? ` · ${r.last}` : ""}
                                </div>
                            </button>
                        )}
                    </For>
                </div>
            </div>

            {/* ── 中：对话流 ─────────────────────────────────── */}
            <div class="flex-1 flex flex-col min-h-0">
                <div class="px-3 py-2 border-b shrink-0 flex items-center gap-2">
                    <div class="font-medium">{room()?.title || roomId() || "未选房间"}</div>
                    <Show when={focusMember()}>
                        <span class="badge badge-sm badge-outline" data-room-focus-label>
                            当前接受者 {focusMember()!.name}
                        </span>
                    </Show>
                    <Show when={badLines() > 0}>
                        <span class="text-caption text-warning" data-room-badlines>
                            事件流有 {badLines()} 行读不出来（已跳过）
                        </span>
                    </Show>
                    <div class="flex-1" />
                    <Show when={busy()}>
                        <span class="text-caption opacity-70" data-room-busy>
                            投递中…（agent 在它自己的会话里跑）
                        </span>
                    </Show>
                </div>

                <div class="relative flex-1 min-h-0 flex flex-col">
                <div
                    class="flex-1 overflow-auto px-3 py-2 space-y-2"
                    ref={(el) => {
                        streamRef = el;
                        setFollow({ ...streamFollowInit }); // 打开房间：从最新看起
                        if (el) queueMicrotask(() => pinBottom(el, true));
                    }}
                    onScroll={(e) => {
                        // ⚠️ 跟随态只由**人滚的**决定：钉底带出来的 scroll 事件不算
                        const el = e.currentTarget;
                        setFollow(
                            onStreamScroll(followNow(), {
                                scrollTop: el.scrollTop,
                                scrollHeight: el.scrollHeight,
                                clientHeight: el.clientHeight,
                            }),
                        );
                    }}
                    data-room-events
                >
                    <Show when={events().length === 0}>
                        <div class="text-caption opacity-50">还没有发言。右栏点 @ 寻址，或直接打字（投给当前接受者）。</div>
                    </Show>
                    <For each={events()}>
                        {(e) => {
                            const mine = () => e.author === human()?.id;
                            const author = () => room()?.members.find((m) => m.id === e.author);
                            // 进度：这条 reply 一出现就把它那一轮取回来（取不到就一直空着，下面如实说）
                            const st = () => turns()[e.id];
                            const isFolded = () => folded()[e.id] === true;
                            createEffect(() => {
                                if (e.kind !== "reply" || !e.ref || st()) return;
                                void loadTurn(e.id);
                            });
                            return (
                                <div
                                    class={`flex ${mine() ? "justify-end" : "justify-start"}`}
                                    data-room-event
                                    data-room-kind={e.kind}
                                    data-room-author={e.author}
                                    data-room-delivered={e.delivered ? "true" : "false"}
                                >
                                    <div class="max-w-[78%] flex flex-col">
                                        <Show when={!mine()}>
                                            <div class="flex items-center gap-1.5 mb-0.5">
                                                <div
                                                    class="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0"
                                                    style={{
                                                        background: `${colorOf(e.author)}33`,
                                                        border: `1px solid ${colorOf(e.author)}`,
                                                    }}
                                                    data-room-avatar={e.author}
                                                >
                                                    {avatarOf(e.author)}
                                                </div>
                                                <span class="text-sm font-medium" style={{ color: colorOf(e.author) }}>
                                                    {author()?.name ?? shortName(e.author)}
                                                </span>
                                                <span class="text-caption opacity-50">{hms(e.ts)}</span>
                                                <Show when={e.to.length > 0}>
                                                    <span class="text-caption opacity-50">→ {e.to.map((t) => memberName(room(), t)).join(" / ")}</span>
                                                </Show>
                                            </div>
                                        </Show>
                                        {/* 这条是**别的房间投进来的**（##377 第 24 刀 · 双向可见）：
                                            源房间那条原话在别处，这里给一句「从哪来」，别让它看起来是本房间自己说的 */}
                                        <Show when={originLabel(e.origin)}>
                                            <div class="text-caption opacity-60 mb-0.5" data-room-origin={e.origin?.roomId}>
                                                🫧 {originLabel(e.origin)}
                                            </div>
                                        </Show>
                                        <div
                                            class={`rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap ${
                                                e.kind === "say" ? "bg-primary/15" : "bg-base-200"
                                            }`}
                                            data-room-text
                                        >
                                            {e.text || <span class="opacity-50">（无正文）</span>}
                                        </div>
                                        {/* 投递状态（每个收件人一条）：排队中 / 投递中 / 已投递 / 未投递 */}
                                        <Show when={(e.deliveries?.length ?? 0) > 0}>
                                            <div class="flex flex-wrap gap-1 mt-0.5">
                                                <For each={e.deliveries}>
                                                    {(d) => (
                                                        <span
                                                            class={`badge badge-xs ${statusClass(d.status)}`}
                                                            title={d.error ?? ""}
                                                            data-room-delivery={`${e.id}:${d.memberId}`}
                                                            data-room-status={d.status}
                                                        >
                                                            {memberName(room(), d.memberId)} · {deliveryStatusText(d.status)}
                                                        </span>
                                                    )}
                                                </For>
                                            </div>
                                        </Show>
                                        <Show when={e.error}>
                                            <div class="text-caption text-error mt-0.5" data-room-undelivered>
                                                {e.kind === "say" ? "未投递：" : ""}
                                                {e.error}
                                            </div>
                                        </Show>
                                        <Show when={e.sourceTask}>
                                            <div class="text-caption opacity-50 mt-0.5" data-room-source>
                                                来自会话 {e.sourceTask}
                                                {e.deliveries?.find((d) => d.memberId === e.author)?.turnId
                                                    ? ` · 轮次 ${e.deliveries!.find((d) => d.memberId === e.author)!.turnId}`
                                                    : ""}
                                            </div>
                                        </Show>
                                        {/* ── 过程进度（##166 §28.7 A）──────────────────────────────
                                            展开的不是"room 自己攒的日志"，而是**那一轮本身**：
                                            `ref = { memberUri, turnId }` → 成员会话的 ops 流切一刀 →
                                            `TurnView`（任务对话页在用的同一个组件）画出来。
                                            于是"room 里的进度"和"任务对话里的进度"是同一份数据、同一套渲染；
                                            room 相对任务对话只多一件事：多条并列（见下方 @dev @review）。 */}
                                        <Show when={e.kind === "reply" && e.ref}>
                                            <div class="mt-1 rounded-lg border border-base-300 bg-base-100/60" data-room-progress={e.id}>
                                                <button
                                                    class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-caption"
                                                    onClick={() => setFolded((p) => ({ ...p, [e.id]: !isFolded() }))}
                                                    data-room-progress-toggle={e.id}
                                                >
                                                    <span class="opacity-60">{isFolded() ? "▸" : "▾"}</span>
                                                    <span>过程进度</span>
                                                    <span class="opacity-50">{shortName(e.author)} · {st()?.turnId ?? e.ref!.turnId}</span>
                                                    <Show when={st()?.live}>
                                                        <span class="badge badge-xs badge-info" data-room-progress-live>
                                                            直播中
                                                        </span>
                                                    </Show>
                                                    <Show when={st() && !st()!.turn && !st()!.error}>
                                                        <span class="opacity-50">（这一轮已不在会话里）</span>
                                                    </Show>
                                                </button>
                                                <Show when={!isFolded()}>
                                                    <div class="px-2 pb-2" data-room-progress-body={e.id}>
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
                    {/* 上翻阅读时不打扰，但给一条「回去」的路 */}
                    <Show when={!stick()}>
                        <button
                            class="absolute bottom-2 right-3 z-10 btn btn-xs"
                            onClick={() => {
                                if (streamRef) pinBottom(streamRef, true);
                            }}
                            data-room-tolatest
                        >
                            ↓ 回到最新
                        </button>
                    </Show>
                </div>

                <div class="border-t px-3 py-2 shrink-0">
                    <Show when={err()}>
                        <div class="text-caption text-error mb-1">{err()}</div>
                    </Show>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-caption opacity-70" data-room-hint>
                            {hint()}
                        </span>
                        <div class="flex-1" />
                        <button class="btn btn-xs btn-ghost" onClick={() => insertAddress("all")} data-room-address-all>
                            @all
                        </button>
                    </div>
                    <div class="flex gap-2">
                        <textarea
                            class="textarea textarea-bordered flex-1 text-sm"
                            rows="2"
                            placeholder="打字… 开头 @dev / @review / @all 指定收件人（可连写多个）；不写则投给当前接受者"
                            value={input()}
                            onInput={(e) => setInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                            data-room-input
                        />
                        <button
                            class="btn btn-sm btn-primary"
                            disabled={!input().trim() || !roomId()}
                            onClick={() => void send()}
                            data-room-send
                        >
                            {busy() ? "发送（会排队）" : "发送"}
                        </button>
                    </div>
                    <div class="text-caption opacity-50 mt-1">Enter 换行 · Cmd/Ctrl+Enter 发送</div>
                </div>
            </div>

            {/* ── 右：成员栏（把房间里的人列出来）────────────────── */}
            <div class="w-60 shrink-0 border-l flex flex-col min-h-0" data-room-roster>
                <div class="px-3 py-2 border-b shrink-0 flex items-center gap-2">
                    <span class="text-caption opacity-70">成员</span>
                    <span class="badge badge-xs">{room()?.members.length ?? 0}</span>
                    <div class="flex-1" />
                    <button
                        class="btn btn-xs btn-ghost"
                        title="清空当前接受者（之后不写 @ 的发言 = 未投递）"
                        onClick={() => void setFocus(null)}
                        data-room-focus-clear
                    >
                        清空接受者
                    </button>
                </div>
                <div class="flex-1 overflow-auto">
                    <For each={ordered()}>
                        {(m, i) => {
                            const isFocus = () => room()?.focus === m.id;
                            return (
                                <div
                                    class={`px-2.5 py-2 border-b cursor-pointer hover:bg-base-200 ${
                                        isFocus() ? "bg-base-200 ring-1 ring-inset ring-primary/40" : ""
                                    }`}
                                    onClick={() => void setFocus(m)}
                                    data-room-member={m.id}
                                    data-room-focus={isFocus() ? "true" : "false"}
                                >
                                    <div class="flex items-center gap-2">
                                        <div
                                            class="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0"
                                            style={{
                                                background: `${memberColor(m)}33`,
                                                border: `1px solid ${memberColor(m)}`,
                                            }}
                                            data-room-avatar={m.id}
                                        >
                                            {memberAvatar(m, i())}
                                        </div>
                                        <div class="min-w-0 flex-1">
                                            <div class="text-sm font-medium truncate flex items-center gap-1">
                                                {m.name}
                                                <Show when={isFocus()}>
                                                    <span class="badge badge-xs badge-primary">接受者</span>
                                                </Show>
                                            </div>
                                            <div class="text-caption opacity-60 truncate">
                                                {m.kind === "human" ? "人 · 你" : m.role || "agent"}
                                            </div>
                                            <Show when={taskOf(m)}>
                                                <div class="text-caption opacity-50 truncate">{taskOf(m)}</div>
                                            </Show>
                                            <Show
                                                when={m.kind !== "human"}
                                                fallback={
                                                    <div class="text-caption opacity-40 truncate mt-0.5" data-room-l1={m.id}>
                                                        在线
                                                    </div>
                                                }
                                            >
                                                <div class="text-caption truncate mt-0.5 flex items-center gap-1" data-room-l1={m.id}>
                                                    <Show
                                                        when={rosterOf(m.id)?.entry?.turn}
                                                        fallback={
                                                            <Show
                                                                when={(rosterOf(m.id)?.queued ?? 0) > 0}
                                                                fallback={<span class="opacity-40">空闲</span>}
                                                            >
                                                                <span class="text-warning">
                                                                    排队中 {rosterOf(m.id)?.queued ?? 0} 条
                                                                </span>
                                                            </Show>
                                                        }
                                                    >
                                                        <span class="inline-block w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                                                        <span class="opacity-70 truncate">
                                                            {rosterOf(m.id)?.action?.label ?? "运行中"}
                                                        </span>
                                                        <span class="opacity-40 shrink-0">
                                                            · 第 {(rosterOf(m.id)?.entry?.turn?.steps ?? 0) + 1} 步
                                                        </span>
                                                        <span class="opacity-40 shrink-0">
                                                            {elapsedText(rosterOf(m.id)?.entry?.turn?.startedAt)}
                                                        </span>
                                                        {/* 跑着也照样报排队数：单成员串行时"后面还压着几条"是用户最关心的状态之一 */}
                                                        <Show when={(rosterOf(m.id)?.queued ?? 0) > 0}>
                                                            <span class="text-warning shrink-0">
                                                                +{rosterOf(m.id)?.queued ?? 0} 排队
                                                            </span>
                                                        </Show>
                                                    </Show>
                                                </div>
                                            </Show>
                                        </div>
                                        <button
                                            class="btn btn-xs btn-ghost"
                                            title={`插入 @${m.name}`}
                                            onClick={(ev) => {
                                                ev.stopPropagation();
                                                insertAddress(m.name);
                                            }}
                                            data-room-address={m.id}
                                        >
                                            @
                                        </button>
                                    </div>
                                </div>
                            );
                        }}
                    </For>
                </div>
                <div class="px-2.5 py-2 border-t shrink-0">
                    <div class="text-caption opacity-70 mb-1">邀请成员（从人物选）</div>
                    <select
                        class="select select-xs select-bordered w-full mb-1"
                        value={invitePersona()}
                        onChange={(e) => setInvitePersona(e.currentTarget.value)}
                        data-room-invite-persona
                    >
                        <option value="">— 选人物 —</option>
                        <For each={personaOptions()}>
                            {(p) => (
                                <option value={p.id} disabled={invitedPersonas().has(p.id)}>
                                    {p.name}
                                    {invitedPersonas().has(p.id) ? "（已在房间）" : ""}
                                </option>
                            )}
                        </For>
                    </select>
                    <button
                        class="btn btn-xs btn-primary w-full"
                        disabled={!invitePersona() || invitedPersonas().has(invitePersona())}
                        onClick={() => void invite()}
                        data-room-invite
                    >
                        邀请（自动配一个会话）
                    </button>
                    <button
                        class="btn btn-xs btn-ghost w-full mt-1"
                        onClick={() => setAdvanced(!advanced())}
                        data-room-advanced-toggle
                    >
                        {advanced() ? "收起高级" : "高级：绑已有任务"}
                    </button>
                    <Show when={advanced()}>
                        <div class="mt-1 pt-1 border-t">
                            <input
                                class="input input-xs input-bordered w-full mb-1"
                                placeholder="名字（@ 寻址用）"
                                value={memberName_()}
                                onInput={(e) => setMemberName_(e.currentTarget.value)}
                                data-room-member-name
                            />
                            <input
                                class="input input-xs input-bordered w-full mb-1"
                                placeholder="绑定任务 URI（projects/1/tasks/1）"
                                value={memberTask()}
                                onInput={(e) => setMemberTask(e.currentTarget.value)}
                                data-room-member-task
                            />
                            <button class="btn btn-xs w-full" onClick={() => void addMember()} data-room-member-add>
                                加入（绑已有任务）
                            </button>
                        </div>
                    </Show>
                </div>
            </div>
        </div>
    );
}

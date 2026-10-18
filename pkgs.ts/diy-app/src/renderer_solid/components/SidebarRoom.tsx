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
 *   · 判据（`parseAddress` / `resolveRecipients` / `deliveryHint`）全走 `shared/room`（与服务端同一份）。
 *
 * 主人格 backend（##166 §30 owner 补拍 · 选 a）：侧边栏没有宿主 task 可绑 ⇒
 * 主人格 = **缺省人物 + 影子 task**（与被邀请成员同一条规则，不搞特例）—— 由 main 侧
 * `room-service::ensureSidebarRoom` 在**首次**取房间时建好，UI 不参与。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
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
import { RoomRoster, type RosterMemberL1 } from "./RoomRoster";
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
    /** 开合（缺省收起 —— 它常驻全局，不能一上来就挡住主界面） */
    const [open, setOpen] = createSignal(false);
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

    const ordered = createMemo(() => orderedMembers(room()));
    const human = createMemo(() => room()?.members.find((m) => m.kind === "human") ?? null);
    const focusMember = createMemo(() => room()?.members.find((m) => m.id === room()?.focus) ?? null);

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
        const { recipients, routing } = resolveRecipients(explicit, r.focus, r.members);
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
            if (!opts.soft) setErr(null);
            void loadRoster(id);
            queueMicrotask(() => {
                if (streamRef) streamRef.scrollTop = streamRef.scrollHeight;
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

    const addMember = async (name: string, task: string): Promise<void> => {
        const id = roomId();
        if (!id || !name || !task) return;
        try {
            await diyService.diy.room.addMember({ id, name, task, persona: undefined, role: undefined });
            await loadRoom(id);
        } catch (e) {
            notificationStore.addToast("error", `加成员失败：${msgOf(e)}`);
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
                queueMicrotask(() => {
                    if (streamRef) streamRef.scrollTop = streamRef.scrollHeight;
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
            {/* 收起态：右缘一个小按钮（常驻，不挡内容） */}
            <Show when={!open()}>
                <button
                    class="fixed right-0 top-1/3 z-40 rounded-l-lg border border-r-0 border-base-300 bg-base-100/95 px-2 py-3 shadow-lg hover:bg-base-200"
                    title="打开侧边栏助手"
                    onClick={() => setOpen(true)}
                    data-sidebar-open
                >
                    <span class="text-lg">💬</span>
                    <div class="text-caption opacity-70 [writing-mode:vertical-rl]">助手</div>
                </button>
            </Show>

            <Show when={open()}>
                <div
                    class="fixed right-0 top-0 z-40 h-full w-[400px] max-w-[92vw] flex flex-col border-l border-base-300 bg-base-100 shadow-2xl"
                    data-sidebar-room
                >
                    {/* 头 */}
                    <div class="px-3 py-2 border-b shrink-0 flex items-center gap-2">
                        <span class="font-medium text-sm">助手房间</span>
                        <span class="badge badge-xs badge-ghost" title={roomId() ?? ""}>
                            {room()?.title || "侧边栏"}
                        </span>
                        <div class="flex-1" />
                        <button
                            class="btn btn-xs btn-ghost"
                            title="收起"
                            onClick={() => setOpen(false)}
                            data-sidebar-close
                        >
                            收起 ▸
                        </button>
                    </div>

                    {/* 成员栏（与房间页同一份组件）—— 高度受限，可滚 */}
                    <RoomRoster
                        class="w-full max-h-56 border-t-0 border-b"
                        room={room()}
                        roster={roster()}
                        onFocus={(m) => void setFocus(m)}
                        onInvite={invite}
                        onAddMember={addMember}
                        onAddress={insertAddress}
                    />

                    {/* 事件流 */}
                    <div
                        class="flex-1 overflow-auto px-3 py-2 space-y-2"
                        ref={(el) => (streamRef = el)}
                        data-sidebar-events
                    >
                        <Show when={events().length === 0}>
                            <div class="text-caption opacity-50">
                                还没有发言。上面点成员卡的 @ 寻址，或直接打字（投给当前接受者）。
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
                                        <div class="max-w-[88%] flex flex-col">
                                            <Show when={!mine()}>
                                                <div class="flex items-center gap-1.5 mb-0.5">
                                                    <div
                                                        class="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0"
                                                        style={{
                                                            background: `${colorOf(e.author)}33`,
                                                            border: `1px solid ${colorOf(e.author)}`,
                                                        }}
                                                        data-sidebar-avatar={e.author}
                                                    >
                                                        {avatarOf(e.author)}
                                                    </div>
                                                    <span class="text-sm font-medium" style={{ color: colorOf(e.author) }}>
                                                        {author()?.name ?? shortName(e.author)}
                                                    </span>
                                                    <span class="text-caption opacity-50">{hms(e.ts)}</span>
                                                    <Show when={e.to.length > 0}>
                                                        <span class="text-caption opacity-50">
                                                            → {e.to.map((t) => memberName(room(), t)).join(" / ")}
                                                        </span>
                                                    </Show>
                                                </div>
                                            </Show>
                                            <div
                                                class={`rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap ${
                                                    e.kind === "say" ? "bg-primary/15" : "bg-base-200"
                                                }`}
                                            >
                                                {e.text || <span class="opacity-50">（无正文）</span>}
                                            </div>
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
                                                <div class="mt-1 rounded-lg border border-base-300 bg-base-100/60" data-sidebar-progress={e.id}>
                                                    <button
                                                        class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-caption"
                                                        onClick={() => setFolded((p) => ({ ...p, [e.id]: !isFolded() }))}
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
                                                        <div class="px-2 pb-2">
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

                    {/* 输入 */}
                    <div class="border-t px-3 py-2 shrink-0">
                        <Show when={err()}>
                            <div class="text-caption text-error mb-1" data-sidebar-error>
                                {err()}
                            </div>
                        </Show>
                        <Show when={badLines() > 0}>
                            <div class="text-caption text-warning mb-1">事件流有 {badLines()} 行读不出来（已跳过）</div>
                        </Show>
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-caption opacity-70" data-sidebar-hint>
                                {hint()}
                            </span>
                            <div class="flex-1" />
                            <Show when={busy()}>
                                <span class="text-caption opacity-70">投递中…</span>
                            </Show>
                            <button class="btn btn-xs btn-ghost" onClick={() => insertAddress("all")}>
                                @all
                            </button>
                        </div>
                        <div class="flex gap-2">
                            <textarea
                                class="textarea textarea-bordered flex-1 text-sm"
                                rows="2"
                                placeholder="打字… 开头 @名字 指定收件人（可连写 / @all）；不写则投给当前接受者"
                                value={input()}
                                onInput={(e) => setInput(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        void send();
                                    }
                                }}
                                data-sidebar-input
                            />
                            <button
                                class="btn btn-sm btn-primary"
                                disabled={!input().trim() || !roomId()}
                                onClick={() => void send()}
                                data-sidebar-send
                            >
                                {busy() ? "发送（会排队）" : "发送"}
                            </button>
                        </div>
                        <div class="text-caption opacity-50 mt-1">Cmd/Ctrl+Enter 发送 · 当前接受者 {focusMember()?.name ?? "（无）"}</div>
                    </div>
                </div>
            </Show>
        </>
    );
}

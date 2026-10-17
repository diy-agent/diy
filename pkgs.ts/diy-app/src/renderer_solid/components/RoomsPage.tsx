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
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
    type DeliveryStatus,
    type Room,
    type RoomEvent,
    type RoomMember,
} from "../../shared/room";

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
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
    const [newId, setNewId] = createSignal("");
    const [newTitle, setNewTitle] = createSignal("");
    const [memberName_, setMemberName_] = createSignal("");
    const [memberTask, setMemberTask] = createSignal("");
    let streamRef: HTMLDivElement | undefined;

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
        const { recipients, routing } = resolveRecipients(explicit, r.focus, r.members);
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
            if (!opts.soft) setErr(null);
            queueMicrotask(() => {
                if (streamRef) streamRef.scrollTop = streamRef.scrollHeight;
            });
        } catch (e) {
            if (!opts.soft) setErr(`读房间失败：${msgOf(e)}`);
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
                queueMicrotask(() => {
                    if (streamRef) streamRef.scrollTop = streamRef.scrollHeight;
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

                <div class="flex-1 overflow-auto px-3 py-2 space-y-2" ref={(el) => (streamRef = el)} data-room-events>
                    <Show when={events().length === 0}>
                        <div class="text-caption opacity-50">还没有发言。右栏点 @ 寻址，或直接打字（投给当前接受者）。</div>
                    </Show>
                    <For each={events()}>
                        {(e) => {
                            const mine = () => e.author === human()?.id;
                            const author = () => room()?.members.find((m) => m.id === e.author);
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
                                    </div>
                                </div>
                            );
                        }}
                    </For>
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
                    <div class="text-caption opacity-70 mb-1">加 agent 成员</div>
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
                        加入
                    </button>
                </div>
            </div>
        </div>
    );
}

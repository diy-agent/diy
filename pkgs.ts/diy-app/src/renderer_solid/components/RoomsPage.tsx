/**
 * RoomsPage — 导航「房间」页（##377 最小切片 / 设计真源 ##166 §28）。
 *
 * 三条口径（全部来自设计，不在这里重新论证）：
 *   · room ≠ session：本页只画「成员栏 + 事件流 + 输入框」，任何成员的历史都不在这里；
 *   · 成员各自独立会话：agent 成员的 backend 绑一个 task —— 页面只显示"它是谁 / 绑哪个任务"，
 *     真跑的那一轮在**它自己的任务会话**里（证据看那个任务的对话/ops 流）；
 *   · 必须 @：输入框默认投给「当前接受者」（成员栏里高亮那位），开头 `@名字` 覆盖它；
 *     两者都没有 ⇒ 只落盘 + **显式标「未投递」**（绝不静默丢弃）。
 *
 * 判据（`resolveRecipients` / `parseAddress` / `deliveryHint`）与 main 侧**同一份实现**
 * （`shared/room.ts`）—— UI 的"将投递给谁"就是服务端真会投给谁，不存在两套 if。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import {
    deliveryHint,
    memberColor,
    memberName,
    parseAddress,
    resolveMember,
    resolveRecipients,
    shortName,
    type Room,
    type RoomEvent,
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
    /** 投递中：post 流还没跑完（agent 真在它自己的会话里干活） */
    const [busy, setBusy] = createSignal(false);
    const [input, setInput] = createSignal("");
    const [newId, setNewId] = createSignal("");
    const [memberName_, setMemberName] = createSignal("");
    const [memberTask, setMemberTask] = createSignal("");
    let streamRef: HTMLDivElement | undefined;

    const refreshRooms = async () => {
        try {
            const r = await diyService.diy.room.list({});
            setRooms(r.rooms);
            setErr(null);
        } catch (e) {
            setErr(`拉房间列表失败：${msgOf(e)}`);
        }
    };

    const openRoom = async (id: string) => {
        try {
            const r = await diyService.diy.room.get({ id, limit: 200 });
            setRoomId(id);
            setRoom(r.room);
            setEvents(r.events);
            setBadLines(r.badLines);
            setErr(r.room ? null : `房间不存在：${id}`);
        } catch (e) {
            setErr(`打开房间失败：${msgOf(e)}`);
        }
    };

    const createRoom = async () => {
        const id = newId().trim();
        if (!id) return;
        try {
            await diyService.diy.room.create({ id, human: "ccc", title: undefined });
            setNewId("");
            await refreshRooms();
            await openRoom(id);
        } catch (e) {
            setErr(`新建房间失败：${msgOf(e)}`);
        }
    };

    const addMember = async () => {
        const id = roomId();
        const name = memberName_().trim();
        const task = memberTask().trim();
        if (!id || !name || !task) return;
        try {
            const r = await diyService.diy.room.addMember({ id, name, task, role: undefined });
            setRoom(r);
            setMemberName("");
            setMemberTask("");
            await refreshRooms();
        } catch (e) {
            setErr(`加成员失败：${msgOf(e)}`);
        }
    };

    const setFocus = async (member: string | undefined) => {
        const id = roomId();
        if (!id) return;
        try {
            const r = await diyService.diy.room.focus({ id, member });
            setRoom(r);
            await refreshRooms();
        } catch (e) {
            setErr(`设当前接受者失败：${msgOf(e)}`);
        }
    };

    /** 本条将投给谁（与 main 同一份判据）—— 输入框下方的护栏文案 */
    const preview = createMemo(() => {
        const r = room();
        if (!r) return "";
        const addr = parseAddress(input());
        const explicit = addr.to ? [resolveMember(r, addr.to)] : [];
        const { recipients } = resolveRecipients(explicit, r.focus);
        return deliveryHint(recipients, r);
    });

    const appendEvent = (ev: RoomEvent) => setEvents((prev) => [...prev, ev]);

    const send = async () => {
        const id = roomId();
        const text = input().trim();
        if (!id || !text || busy()) return;
        setBusy(true);
        setInput("");
        try {
            // post 是 serverStream：逐条事件（say → 各 agent 的 reply）边走边落盘、边走边回显
            const stream = await diyService.diy.room.post({ id, text });
            for await (const line of stream) {
                appendEvent(JSON.parse(String(line)) as RoomEvent);
                if (streamRef) streamRef.scrollTop = streamRef.scrollHeight;
            }
        } catch (e) {
            setErr(`投递失败：${msgOf(e)}`);
            notificationStore.addToast("error", `房间投递失败：${msgOf(e)}`);
        } finally {
            setBusy(false);
            await refreshRooms();
        }
    };

    onMount(() => {
        void refreshRooms();
    });

    // 轻量轮询：CLI / 别的窗口往房间写的发言也要能看见（本切片不做推送，写进开发日志）
    onMount(() => {
        const t = setInterval(() => {
            const id = roomId();
            if (!id || busy() || document.visibilityState !== "visible") return;
            void diyService.diy.room
                .get({ id, limit: 200 })
                .then((r) => {
                    if (r.room) {
                        setRoom(r.room);
                        setEvents(r.events);
                        setBadLines(r.badLines);
                    }
                })
                .catch(() => {
                    /* 轮询失败不打扰：显式操作（发送/切房间/刷新）才报错 */
                });
        }, 3000);
        onCleanup(() => clearInterval(t));
    });

    return (
        <div class="flex h-full min-h-0" data-room-page>
            {/* 左：房间列表 + 成员栏 */}
            <div class="w-72 shrink-0 border-r flex flex-col min-h-0">
                <div class="px-3 py-2 border-b shrink-0">
                    <div class="text-caption opacity-70 mb-1">房间</div>
                    <div class="flex gap-1">
                        <input
                            class="input input-xs input-bordered flex-1"
                            placeholder="新房间 id"
                            value={newId()}
                            onInput={(e) => setNewId(e.currentTarget.value)}
                            data-room-new-id
                        />
                        <button class="btn btn-xs" onClick={() => void createRoom()} data-room-create>
                            新建
                        </button>
                    </div>
                </div>
                <div class="overflow-auto max-h-40 shrink-0 border-b">
                    <For each={rooms()}>
                        {(r) => (
                            <button
                                class={`w-full text-left px-3 py-1.5 text-sm hover:bg-base-200 ${
                                    roomId() === r.id ? "bg-base-200 font-medium" : ""
                                }`}
                                onClick={() => void openRoom(r.id)}
                                data-room-item={r.id}
                            >
                                <div>{r.title || r.id}</div>
                                <div class="text-caption opacity-60 truncate">
                                    {r.members} 名成员{r.last ? ` · ${r.last}` : ""}
                                </div>
                            </button>
                        )}
                    </For>
                </div>

                {/* 成员栏（验收判据 1）：人 + 多 agent；focus 高亮，点击即可换当前接受者 */}
                <div class="px-3 py-2 border-b shrink-0 text-caption opacity-70">成员（点选 = 当前接受者）</div>
                <div class="flex-1 overflow-auto" data-room-members>
                    <For each={room()?.members ?? []}>
                        {(m) => (
                            <div
                                class={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-base-200 ${
                                    room()?.focus === m.id ? "bg-base-200" : ""
                                }`}
                                onClick={() => void setFocus(m.id)}
                                data-room-member={m.id}
                                data-room-focus={room()?.focus === m.id ? "true" : "false"}
                            >
                                <span class="h-2 w-2 rounded-full shrink-0" style={{ background: memberColor(m) }} />
                                <span class="font-medium">{m.name}</span>
                                <span class="text-caption opacity-60">{m.kind === "human" ? "人" : "agent"}</span>
                                <Show when={room()?.focus === m.id}>
                                    <span class="ml-auto text-caption">◀ 当前</span>
                                </Show>
                            </div>
                        )}
                    </For>
                    <div class="px-3 py-2 text-caption opacity-60">
                        {room()?.members.length ? "" : "还没有成员"}
                    </div>
                    <div class="px-3 py-2 border-t">
                        <div class="text-caption opacity-70 mb-1">加 agent 成员（绑一个任务的本地会话）</div>
                        <input
                            class="input input-xs input-bordered w-full mb-1"
                            placeholder="成员名（@ 用，如 dev）"
                            value={memberName_()}
                            onInput={(e) => setMemberName(e.currentTarget.value)}
                            data-room-member-name
                        />
                        <input
                            class="input input-xs input-bordered w-full mb-1"
                            placeholder="任务 URI（projects/4/tasks/N）"
                            value={memberTask()}
                            onInput={(e) => setMemberTask(e.currentTarget.value)}
                            data-room-member-task
                        />
                        <button class="btn btn-xs w-full" onClick={() => void addMember()} data-room-add-member>
                            加成员
                        </button>
                    </div>
                </div>
            </div>

            {/* 右：事件流 + 输入 */}
            <div class="flex-1 flex flex-col min-h-0 min-w-0">
                <Show
                    when={room()}
                    fallback={
                        <div class="flex-1 flex items-center justify-center text-sm opacity-60">
                            左栏选一个房间，或输入 id 新建
                        </div>
                    }
                >
                    {(r) => (
                        <>
                            <div class="px-3 py-2 border-b shrink-0 flex items-center gap-2">
                                <span class="font-medium" data-room-title>
                                    {r().title || r().id}
                                </span>
                                <span class="text-caption opacity-60" data-room-focus-label>
                                    {r().focus ? `当前接受者：${memberName(r(), r().focus!)}` : "当前接受者：未设"}
                                </span>
                                <Show when={badLines() > 0}>
                                    <span class="text-caption text-error">（事件流有 {badLines()} 行坏数据）</span>
                                </Show>
                                <button
                                    class="btn btn-xs ml-auto"
                                    onClick={() => setFocus(undefined)}
                                    data-room-focus-clear
                                >
                                    清空接受者
                                </button>
                            </div>
                            <Show when={err()}>
                                <div class="px-3 py-1.5 text-sm text-error border-b" data-room-error>
                                    {err()}
                                </div>
                            </Show>

                            {/* 事件流（验收判据 1 / 4 / 5）：每条发言带署名 + 投递标注 */}
                            <div class="flex-1 overflow-auto p-3 space-y-2 min-h-0" ref={(el) => (streamRef = el)} data-room-events>
                                <For each={events()}>
                                    {(ev) => (
                                        <div
                                            class={`flex ${ev.author.startsWith("human:") ? "justify-end" : "justify-start"}`}
                                            data-room-event={ev.id}
                                            data-room-author={ev.author}
                                            data-room-delivered={ev.delivered ? "true" : "false"}
                                            data-room-kind={ev.kind}
                                        >
                                            <div
                                                class={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words border ${
                                                    ev.author.startsWith("human:")
                                                        ? "bg-primary/10 border-primary/20"
                                                        : "bg-base-200 border-base-300"
                                                }`}
                                            >
                                                <div class="flex items-center gap-1.5 mb-0.5 text-caption opacity-70">
                                                    <span
                                                        class="inline-block h-2 w-2 rounded-full shrink-0"
                                                        style={{
                                                            background: memberColor({
                                                                id: ev.author,
                                                                color: r().members.find((m) => m.id === ev.author)?.color,
                                                            }),
                                                        }}
                                                    />
                                                    <span class="font-medium">{shortName(ev.author)}</span>
                                                    <span>{hms(ev.ts)}</span>
                                                    <Show when={ev.kind === "reply"}>
                                                        <span>· 回复</span>
                                                    </Show>
                                                    <Show when={ev.to.length > 0}>
                                                        <span data-room-to>
                                                            → {ev.to.map((t) => memberName(r(), t)).join(" / ")}
                                                        </span>
                                                    </Show>
                                                </div>
                                                <Show when={ev.text}>{ev.text}</Show>
                                                {/* 未投递 / 投递失败必须看得见（判据 5） */}
                                                <Show when={!ev.delivered}>
                                                    <div class="mt-1 text-caption text-warning" data-room-undelivered>
                                                        未投递{ev.error ? `：${ev.error}` : ""}
                                                    </div>
                                                </Show>
                                                <Show when={ev.delivered && ev.error}>
                                                    <div class="mt-1 text-caption text-warning">{ev.error}</div>
                                                </Show>
                                                <Show when={ev.sourceTask}>
                                                    <div class="mt-1 text-caption opacity-50" data-room-source-task>
                                                        来自会话 {ev.sourceTask}
                                                    </div>
                                                </Show>
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>

                            <div class="border-t p-3 shrink-0">
                                <div class="flex gap-2">
                                    <input
                                        class="input input-sm input-bordered flex-1"
                                        placeholder={
                                            r().focus ? `对 ${memberName(r(), r().focus!)} 说…（@名字 可改投递对象）` : "说点什么（无接受者 = 只落盘不投递）"
                                        }
                                        value={input()}
                                        onInput={(e) => setInput(e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && !e.shiftKey) {
                                                e.preventDefault();
                                                void send();
                                            }
                                        }}
                                        data-room-input
                                    />
                                    <button class="btn btn-sm btn-primary" disabled={busy()} onClick={() => void send()} data-room-send>
                                        {busy() ? "投递中…" : "发送"}
                                    </button>
                                </div>
                                <div class="text-caption opacity-60 mt-1" data-room-hint>
                                    {busy() ? "已投出，等对方在自己的会话里跑完（回复会自动回显）" : preview()}
                                </div>
                            </div>
                        </>
                    )}
                </Show>
            </div>
        </div>
    );
}

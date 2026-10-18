/**
 * RoomRoster — 房间**成员栏**（可复用：独立房间页 + 任务对话页共用同一份）。
 *
 * 为什么抽出来（##377 第 7 刀 · 宿主搬迁）：##166 §28.8 定案「room 的宿主 = 任务对话页」
 * ⇒ 成员栏 / 邀请面板要从 `RoomsPage` 搬进 `LocalChatPage`；口径要求「**复用，别复制**」
 * ⇒ 抽成本组件两边都用（`RoomsPage` 同时降级为「房间列表」）。
 *
 * 职责边界：只画「谁在房间里 / 此刻在干什么 / 怎么加人」。
 * **不碰时间线、不碰投递** —— 那两件事归调用方（各页的输入框/事件流各不相同），
 * 所以同一个组件在 room 页与任务页都能用。
 *
 * 判据（头像 / 配色 / 顺序 / 人物护栏）与 main 侧同一份实现（`shared/room.ts`）。
 */
import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js";
import {
    memberAvatar,
    memberColor,
    orderedMembers,
    type Room,
    type RoomMember,
} from "../../shared/room";
import { personaStore } from "../store/personaStore";

/** 成员 L1 状态（`diy.room.roster` 的一行；**字段真源在 main** —— 这里只做显示，不推断） */
export interface RosterMemberL1 {
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
export const elapsedText = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
};

/** 成员绑的会话（人成员没有 backend ⇒ 空串，UI 不显示那一行） */
function taskOf(m: RoomMember | undefined): string {
    return m?.backend?.type === "task" ? (m.backend.data.taskUri ?? "") : "";
}

export interface RoomRosterProps {
    room: Room | null;
    /** L1 状态（`diy.room.roster`）；读不到就传空数组（状态行空着，不影响成员列表） */
    roster: RosterMemberL1[];
    /** 点成员卡 = 设它作「当前接受者」；传 null = 清空接受者 */
    onFocus: (m: RoomMember | null) => void;
    /** 邀请（主路径）：选人物 → 调用方去 `room.invite`（自动配影子 task 作 backend） */
    onInvite: (personaId: string) => void | Promise<void>;
    /** 高级入口：手填名字 + 绑**已有** task（默认收起） */
    onAddMember: (name: string, task: string) => void | Promise<void>;
    /** 点成员卡上的 `@`（把 `@名` 塞进调用方输入框）；**不传 ⇒ 不显示该按钮** */
    onAddress?: (name: string) => void;
    /** 外层 class（宽度由调用方定；缺省 `w-60`） */
    class?: string;
}

export function RoomRoster(props: RoomRosterProps): JSX.Element {
    const [invitePersona, setInvitePersona] = createSignal("");
    /** 高级入口默认收起 —— §28.K 待拍 19：长留但不暴露 */
    const [advanced, setAdvanced] = createSignal(false);
    const [memberName_, setMemberName_] = createSignal("");
    const [memberTask, setMemberTask] = createSignal("");

    /** 成员展示顺序（人先、agent 后）—— 顺序与头像位次同一份（同房间内头像不撞） */
    const ordered = createMemo(() => orderedMembers(props.room));
    const rosterOf = (id: string): RosterMemberL1 | undefined =>
        props.roster.find((m) => m.memberId === id);

    /**
     * 已在房间的人物（护栏，##166 §28.7 F）：**同一 backend 不得挂两个人物**（A 帽子，§27 已否）。
     * 注：**同一人物可进多个 room**（允许）—— 这里禁的是"同一个房间里同一个人物再来一个"，
     * 因为成员名是 `@` 寻址的键，重名会让寻址有歧义（`resolveMember` 取第一个）。
     */
    const invitedPersonas = createMemo(
        () =>
            new Set(
                (props.room?.members ?? []).map((m) => m.persona).filter((x): x is string => !!x),
            ),
    );
    /** 人物清单 —— 直接用 `personaStore`（人物管理页同一份缓存），不自己再拉一遍 */
    const personaOptions = createMemo(() =>
        personaStore.personas.map((p) => ({ id: p.id, name: p.name })),
    );

    const doInvite = async (): Promise<void> => {
        const pid = invitePersona();
        if (!pid || invitedPersonas().has(pid)) return;
        await props.onInvite(pid);
        setInvitePersona("");
    };

    const doAdd = async (): Promise<void> => {
        const name = memberName_().trim();
        const task = memberTask().trim();
        if (!name || !task) return;
        await props.onAddMember(name, task);
        setMemberName_("");
        setMemberTask("");
    };

    onMount(() => void personaStore.load());

    return (
        <div
            class={`flex flex-col min-h-0 ${props.class ?? "w-60 shrink-0 border-l"}`}
            data-room-roster
        >
            <div class="px-3 py-2 border-b shrink-0 flex items-center gap-2">
                <span class="text-caption opacity-70">成员</span>
                <span class="badge badge-xs">{props.room?.members.length ?? 0}</span>
                <div class="flex-1" />
                <button
                    class="btn btn-xs btn-ghost"
                    title="清空当前接受者（之后不写 @ 的发言 = 未投递）"
                    onClick={() => props.onFocus(null)}
                    data-room-focus-clear
                >
                    清空接受者
                </button>
            </div>
            <div class="flex-1 overflow-auto">
                <For each={ordered()}>
                    {(m, i) => {
                        const isFocus = () => props.room?.focus === m.id;
                        return (
                            <div
                                class={`px-2.5 py-2 border-b cursor-pointer hover:bg-base-200 ${
                                    isFocus() ? "bg-base-200 ring-1 ring-inset ring-primary/40" : ""
                                }`}
                                onClick={() => props.onFocus(m)}
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
                                            <div class="text-caption opacity-50 truncate">
                                                {taskOf(m)}
                                            </div>
                                        </Show>
                                        <Show
                                            when={m.kind !== "human"}
                                            fallback={
                                                <div
                                                    class="text-caption opacity-40 truncate mt-0.5"
                                                    data-room-l1={m.id}
                                                >
                                                    在线
                                                </div>
                                            }
                                        >
                                            <div
                                                class="text-caption truncate mt-0.5 flex items-center gap-1"
                                                data-room-l1={m.id}
                                            >
                                                <Show
                                                    when={rosterOf(m.id)?.entry?.turn}
                                                    fallback={
                                                        <Show
                                                            when={(rosterOf(m.id)?.queued ?? 0) > 0}
                                                            fallback={
                                                                <span class="opacity-40">空闲</span>
                                                            }
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
                                                        · 第{" "}
                                                        {(rosterOf(m.id)?.entry?.turn?.steps ?? 0) + 1} 步
                                                    </span>
                                                    <span class="opacity-40 shrink-0">
                                                        {elapsedText(
                                                            rosterOf(m.id)?.entry?.turn?.startedAt,
                                                        )}
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
                                    <Show when={props.onAddress}>
                                        <button
                                            class="btn btn-xs btn-ghost"
                                            title={`插入 @${m.name}`}
                                            onClick={(ev) => {
                                                ev.stopPropagation();
                                                props.onAddress?.(m.name);
                                            }}
                                            data-room-address={m.id}
                                        >
                                            @
                                        </button>
                                    </Show>
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
                    onClick={() => void doInvite()}
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
                        <button
                            class="btn btn-xs w-full"
                            onClick={() => void doAdd()}
                            data-room-member-add
                        >
                            加入（绑已有任务）
                        </button>
                    </div>
                </Show>
            </div>
        </div>
    );
}

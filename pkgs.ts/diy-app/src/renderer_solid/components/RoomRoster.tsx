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
 *
 * ##377 第 9 刀：删「高级：绑已有任务」UI 入口（后端 `room.addMember` 保留不动）+ 加 `onRemove`。
 *
 * ##377 第 12 刀（##166 §38.3 · **层级披露**）—— 用户原话「成员面板保持简洁，不要有删除等按钮，
 * 应该是 hover 后弹出贴成员的侧边栏…… 通过**层级披露**信息方式减轻用户信息压力」：
 *
 * | 层 | 放什么 | 在哪 |
 * |---|---|---|
 * | **常态（紧凑）** | 头像 + `@名字` + 焦点标记 + L1 状态；**行内零按钮** | 成员列表（**每人 2 行**） |
 * | **hover 浮层** | 人物 · backend（影子 task，可点跳）· 最近活动 · 排队数 + **移出** | **贴成员列表左侧**弹出（`right-full`），**不遮列表本身** |
 * | **viewbar** | room 的 view 级操作（房间名 / 焦点 / 邀请…） | 调用方的 viewbar |
 *
 * ⚠️ **定位方向与 App 的导航 hover 相反**：`App.tsx` 那套是「优先贴右、不够才贴左」，
 * 而成员栏**本身就在屏幕最右缘** ⇒ 这边必须**贴左**（浮层左边界 = 成员栏左边界）。
 * ⚠️ **延迟隐藏**（同 App 的 `hoverHideTimer` 思路）：鼠标从行移到浮层上的途中不能消失，
 * 否则浮层里的按钮永远点不到。
 * ⚠️ **浮层必须 Portal + fixed**：行在 `overflow-auto` 容器里，行内 absolute 会被裁掉
 * （第 12 刀实测：rect 量着对、实际不可见不可命中 ⇒ hover 必现 180ms 闪没）。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import {
    memberAvatar,
    memberColor,
    orderedMembers,
    type Room,
    type RoomMember,
} from "../../shared/room";
import { personaStore } from "../store/personaStore";
import { getRendererActions } from "../lib/renderer-actions";

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

/** `projects/4/tasks/377` → `#377`（二级信息一行摘要要短） */
function taskShort(uri: string): string {
    const m = /^projects\/(\d+)\/tasks\/(\d+)$/.exec(uri);
    return m ? `#${m[2]}` : uri;
}

export interface RoomRosterProps {
    room: Room | null;
    /** L1 状态（`diy.room.roster`）；读不到就传空数组（状态行空着，不影响成员列表） */
    roster: RosterMemberL1[];
    /** 点**名字** = 设它作「当前接受者」；传 null = 清空接受者 */
    onFocus: (m: RoomMember | null) => void;
    /** 邀请（主路径）：选人物 → 调用方去 `room.invite`（自动配影子 task 作 backend） */
    onInvite: (personaId: string) => void | Promise<void>;
    /**
     * 高级入口：手填名字 + 绑**已有** task。
     * ⚠️ ##377 第 9 刀：**UI 入口已删**（用户要求「删除绑定任务功能」）——
     * 字段留着只为不破坏既有调用方（`RoomsPage` 仍传），**本组件不再渲染它**。
     */
    onAddMember?: (name: string, task: string) => void | Promise<void>;
    /** 移出成员（**不传 ⇒ 浮层里不显示该操作**）；主人格 / 人成员由本组件直接禁掉（服务端另有护栏） */
    onRemove?: (m: RoomMember) => void | Promise<void>;
    /** 把 `@名` 塞进调用方输入框（浮层里的便捷操作）；**不传 ⇒ 不显示** */
    onAddress?: (name: string) => void;
    /**
     * **点头像** = 三级披露（##166 §39.2 ③）：打开人物编辑半截页。
     * 调用方负责把 `m.persona` 交给 `PersonaDrawer`（本组件不碰抽屉）。
     */
    onPersona?: (m: RoomMember) => void;
    /** 外层 class（宽度由调用方定；缺省 `w-60`） */
    class?: string;
}

export function RoomRoster(props: RoomRosterProps): JSX.Element {
    const [invitePersona, setInvitePersona] = createSignal("");
    /**
     * hover 到哪个成员（决定浮层显示；`null` = 没有）+ 锚点行的 rect。
     *
     * ⚠️ 浮层必须 **Portal 到 body 用 `fixed` 定位**（##377 第 12 刀实测的坑）：
     * 成员行在 `overflow-auto` 的滚动容器里，行内 `absolute right-full` 会被整体裁掉 ——
     * 几何 rect 量着是对的（在左侧），但 `elementFromPoint` 命中的是会话流内容 ⇒
     * 浮层**看不见**、`mouseenter` 永不触发 ⇒ `cancelHide` 从不被调 ⇒ 180ms 后消失。
     * 同坑的既有解法见 `TaskDetailContent.tsx` TaskNameLink 头注（Portal + fixed）。
     */
    const [hover, setHover] = createSignal<{ id: string; left: number; top: number } | null>(
        null,
    );
    /** 延迟隐藏：鼠标从行移到浮层的途中不能消失（否则浮层里的按钮点不到） */
    let hideTimer: number | undefined;
    const cancelHide = (): void => {
        if (hideTimer !== undefined) window.clearTimeout(hideTimer);
        hideTimer = undefined;
    };
    const scheduleHide = (): void => {
        cancelHide();
        hideTimer = window.setTimeout(() => setHover(null), 180);
    };
    onCleanup(cancelHide);
    /** 浮层定位：贴触发行**左侧**（成员栏在屏幕右缘 ⇒ 向左展开才不遮列表）；4px 缝 = 原 `mr-1` */
    const floatLeft = (): number => {
        const h = hover();
        return h ? Math.max(8, Math.round(h.left - 4 - 256)) : 0; // w-64 = 256px
    };

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
    const personaName = (id: string | undefined): string =>
        id ? (personaStore.personas.find((p) => p.id === id)?.name ?? id) : "";

    const doInvite = async (): Promise<void> => {
        const pid = invitePersona();
        if (!pid || invitedPersonas().has(pid)) return;
        await props.onInvite(pid);
        setInvitePersona("");
    };

    onMount(() => void personaStore.load());

    /** 行 1 右侧的 L1 状态（**一行短文本**：紧凑是判据，不能因为加了信息把行撑高） */
    const l1Text = (id: string): string => {
        const r = rosterOf(id);
        if (!r) return "";
        if (r.entry?.turn) {
            const step = (r.entry.turn.steps ?? 0) + 1;
            const t = elapsedText(r.entry.turn.startedAt);
            const q = r.queued > 0 ? ` +${r.queued}排队` : "";
            return `▶ 第${step}步${t ? ` ${t}` : ""}${q}`;
        }
        if (r.queued > 0) return `排队 ${r.queued}`;
        return r.isHuman ? "在线" : "空闲";
    };

    return (
        <div
            class={`flex flex-col min-h-0 ${props.class ?? "w-60 shrink-0 border-l"}`}
            data-room-roster
        >
            {/* 头部：只剩「成员 + 计数」—— view 级操作（清空接受者等）归调用方的 viewbar（§38.3） */}
            <div class="px-3 py-1.5 shrink-0 flex items-center gap-2" data-room-roster-head>
                <span class="text-caption opacity-70">成员</span>
                <span class="badge badge-xs">{props.room?.members.length ?? 0}</span>
            </div>
            <div
                class="flex-1 overflow-auto"
                onScroll={() => {
                    cancelHide();
                    setHover(null);
                }}
            >
                <For each={ordered()}>
                    {(m, i) => {
                        const isFocus = () => props.room?.focus === m.id;
                        const task = () => taskOf(m);
                        return (
                            <div
                                class={`relative px-2 py-1 ${isFocus() ? "bg-base-200/70" : ""}`}
                                data-room-member={m.id}
                                data-room-focus={isFocus() ? "true" : "false"}
                            >
                                <div class="flex items-center gap-2">
                                    {/* 二级：**hover 头像** → 高亮（daisyUI `.aura`，只在 hover 时挂 class ⇒ 不 hover 不耗）
                                        + 二级浮窗；三级：**点头像** → 人物编辑半截页（复用 PersonaDrawer）。
                                        ⚠️ `.aura` 带 2px padding ⇒ 用 `-m-[2px]` 抵消，**行高不因此变**（§39.2 紧凑护栏） */}
                                    <div
                                        class={
                                            hover()?.id === m.id
                                                ? "aura -m-[2px] shrink-0"
                                                : "shrink-0"
                                        }
                                        style={{ color: memberColor(m) }}
                                    >
                                        <div
                                            class="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                                            style={{
                                                background: `${memberColor(m)}33`,
                                                border: `1px solid ${memberColor(m)}`,
                                            }}
                                            onMouseEnter={(e) => {
                                                cancelHide();
                                                const row = e.currentTarget
                                                    .closest("[data-room-member]")
                                                    ?.getBoundingClientRect();
                                                setHover({
                                                    id: m.id,
                                                    left: row?.left ?? 0,
                                                    top: row?.top ?? 0,
                                                });
                                            }}
                                            onMouseLeave={scheduleHide}
                                            onClick={() => {
                                                if (m.persona) props.onPersona?.(m);
                                            }}
                                            title={
                                                m.persona
                                                    ? `打开人物编辑（${personaName(m.persona)}）`
                                                    : "人成员（没有人物可编辑）"
                                            }
                                            data-room-avatar={m.id}
                                        >
                                            {memberAvatar(m, i())}
                                        </div>
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        {/* 行 1：`@` 在名字前（用户点名） + 焦点标记 + L1 状态 */}
                                        <div class="flex items-center gap-1.5 min-w-0">
                                            <button
                                                class="text-body font-medium truncate hover:underline decoration-dotted underline-offset-2"
                                                title={`设为当前接受者（@${m.name}）`}
                                                onClick={() => props.onFocus(m)}
                                                data-room-name={m.id}
                                            >
                                                @{m.name}
                                            </button>
                                            <Show when={isFocus()}>
                                                <span class="badge badge-xs badge-primary shrink-0">
                                                    接受者
                                                </span>
                                            </Show>
                                            <div class="flex-1" />
                                            <span
                                                class="text-caption opacity-50 shrink-0 truncate"
                                                data-room-l1={m.id}
                                            >
                                                {l1Text(m.id)}
                                            </span>
                                        </div>
                                        {/* 行 2：二级信息一行摘要（kind · 角色 · 影子 task 短名） */}
                                        <div
                                            class="text-caption opacity-45 truncate"
                                            data-room-member-sub={m.id}
                                        >
                                            {m.kind === "human" ? "人 · 你" : m.role || "agent"}
                                            <Show when={task()}>
                                                {" · "}
                                                {taskShort(task())}
                                            </Show>
                                            <Show when={m.persona}>
                                                {" · "}
                                                {personaName(m.persona)}
                                            </Show>
                                        </div>
                                    </div>
                                </div>

                                {/* ── 二级：hover 浮层（**贴左**：成员栏在屏幕右缘，向左展开才不遮列表） ── */}
                                <Show when={hover()?.id === m.id}>
                                    <Portal>
                                        <div
                                            class="fixed z-[120] w-64 rounded-lg border p-2 shadow-xl"
                                            style={{
                                                left: `${floatLeft()}px`,
                                                top: `${Math.round(hover()?.top ?? 0)}px`,
                                                background: "var(--diy-surface-overlay)",
                                                "border-color": "var(--diy-overlay-edge)",
                                            }}
                                            onMouseEnter={cancelHide}
                                            onMouseLeave={scheduleHide}
                                            data-room-member-hover={m.id}
                                        >
                                        <div class="flex items-center gap-2 mb-1.5">
                                            <div
                                                class="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0"
                                                style={{
                                                    background: `${memberColor(m)}33`,
                                                    border: `1px solid ${memberColor(m)}`,
                                                }}
                                            >
                                                {memberAvatar(m, i())}
                                            </div>
                                            <div class="min-w-0">
                                                <div class="text-body font-medium truncate">
                                                    {m.name}
                                                </div>
                                                <div class="text-caption opacity-50 truncate">
                                                    {m.id}
                                                </div>
                                            </div>
                                        </div>
                                        <div class="text-caption space-y-0.5">
                                            <div>
                                                <span class="opacity-50">角色 </span>
                                                {m.kind === "human" ? "人（你）" : m.role || "agent"}
                                                <Show when={m.main}>
                                                    <span class="badge badge-xs badge-ghost ml-1">
                                                        主人格
                                                    </span>
                                                </Show>
                                            </div>
                                            <Show when={m.persona}>
                                                <div>
                                                    <span class="opacity-50">人物 </span>
                                                    {personaName(m.persona)}
                                                </div>
                                            </Show>
                                            <Show when={task()}>
                                                <div class="truncate">
                                                    <span class="opacity-50">会话 </span>
                                                    <button
                                                        class="link link-hover"
                                                        title="打开这个会话"
                                                        onClick={() =>
                                                            getRendererActions().openTaskRun?.(task())
                                                        }
                                                        data-room-hover-task={m.id}
                                                    >
                                                        {taskShort(task())}
                                                    </button>
                                                    <span class="opacity-40">
                                                        {" "}
                                                        {task().replace(/^projects\/\d+\//, "")}
                                                    </span>
                                                </div>
                                            </Show>
                                            <div>
                                                <span class="opacity-50">活动 </span>
                                                {rosterOf(m.id)?.entry
                                                    ? `${rosterOf(m.id)!.entry!.turnCount} 轮 / ${rosterOf(m.id)!.entry!.totalSteps} 步`
                                                    : "无记录"}
                                                <Show when={rosterOf(m.id)?.action?.label}>
                                                    {" · "}
                                                    {rosterOf(m.id)!.action!.label}
                                                </Show>
                                            </div>
                                            <Show when={(rosterOf(m.id)?.queued ?? 0) > 0}>
                                                <div class="text-warning">
                                                    排队 {rosterOf(m.id)!.queued} 条
                                                </div>
                                            </Show>
                                        </div>
                                        <div class="flex items-center gap-1 mt-2 pt-1.5 border-t border-base-content/10">
                                            <Show when={props.onAddress}>
                                                <button
                                                    class="btn btn-xs btn-ghost"
                                                    title={`把 @${m.name} 塞进输入框`}
                                                    onClick={() => props.onAddress?.(m.name)}
                                                    data-room-address={m.id}
                                                >
                                                    @ 寻址
                                                </button>
                                            </Show>
                                            <div class="flex-1" />
                                            {/* 移出：主人格不可移出（它就是宿主本身，服务端也拦）；
                                                人成员不走这条路（人 = 页面操作者本人，无 backend） */}
                                            <Show when={props.onRemove && !m.main && m.kind !== "human"}>
                                                <button
                                                    class="btn btn-xs btn-ghost text-error"
                                                    title={`把 ${m.name} 移出房间（影子任务保留，只是不再是成员）`}
                                                    onClick={() => void props.onRemove?.(m)}
                                                    data-room-remove={m.id}
                                                >
                                                    移出
                                                </button>
                                            </Show>
                                        </div>
                                        </div>
                                    </Portal>
                                </Show>
                            </div>
                        );
                    }}
                </For>
            </div>
            {/* 邀请：room 的 view 级操作，仍留在成员栏底部（侧边栏 viewbar 太窄，放不下选择器） */}
            <div class="px-2.5 py-2 border-t border-base-content/10 shrink-0">
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
            </div>
        </div>
    );
}

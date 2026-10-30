import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { localChatStore } from "../../store/localChatStore";
import { IconBolt, IconClock, IconCompress, IconExpand, IconGrip } from "@diy-agent/ui-kit";
import { copyFailMeta, copyOkMeta } from "../../lib/notice-copy";
import { notificationStore } from "../../store/notificationStore";
import { deliveryStateText, memberAvatar, memberColor, memberName, orderedMembers, steerTurnRefs, type Room, type RoomEvent } from "../../../shared/room";
import { fmtClock } from "../../../shared/date-format";
import { diyService } from "../../lib/rpc";
import type { SteerItem } from "../../../main/core/drafts";
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from "@dnd-kit/solid";
import type { DragDropProviderProps } from "@dnd-kit/solid";
import type { BlockNode } from "../../../main/services/local-blocks";
import { ChatView } from "./MessageStream";
import { TurnView } from "./TurnView";

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

export function RoomSayRow(props: {
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

export function RoomReplyRow(props: {
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

export function SteerBar(props: {
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
export function FullscreenModal(props: { title: string; content: string; onClose: () => void }) {
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
export function VirtRow(props: {
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

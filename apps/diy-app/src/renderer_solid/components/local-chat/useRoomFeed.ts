/**
 * useRoomFeed — 本任务的 room 时间线（##377 第 16/17 刀 / ##166 §43.3 B · §44.2 B）。
 *
 * 从 `LocalChatPage` 逐字搬出（##448 刀 2：页面文件 ≤1200 行）。它是对话流的**第二源**：
 * 任务对话只有本会话的轮，room 里还有别人说的话 / 插话 / 回复，要按时间插进同一条流。
 * 依赖只有 `uri` 与 `rosterAutoFor`；状态仍归本 Hook，页面只读它的返回值。
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { localChatStore } from "../../store/localChatStore";
import { memberCompletion, taskCompletion } from "../../lib/completions";
import { MAIN_MEMBER_ID, opsOwnsEvent, type Room, type RoomEvent } from "../../../shared/room";
import { diyService } from "../../lib/rpc";
import { layoutStore } from "../../store/layoutStore";

export function useRoomFeed(props: { uri: () => string | null; rosterAutoFor?: string }) {
    const { uri } = props;
    // ─── room：本任务的时间线第二源（##377 第 16/17 刀 / ##166 §43.3 B · §44.2 B）──────
    // 任务页的时间线 = **本任务 ops 流**（主人格，逐字不变）+ room 事件流里
    // **ops 流没有的那部分**。谁归谁**只由一条判据定**（`shared/room.opsOwnsEvent`，纯函数有单测）：
    //   · `say` 投给了主人格 ⇒ ops 里有 user 块 ⇒ room 跳过；`@dev` ⇒ 不在任何本任务会话里 ⇒ room 画；
    //   · `reply` 来自主人格 ⇒ 就是它自己那一轮 ⇒ room 跳过；别人回的 ⇒ room 画。
    // 三条边界（§32.3）：
    //   · **不拷块流**：这里只拿 `ref{memberUri, turnId}` 定位，L2 展开时才按需读那一轮
    //     （`room.turn`），数据始终只住在那位成员的会话里；
    //   · **只读**：room 侧不写任何东西（发送走 `localChatStore.sendViaRoom` 的投递口）；
    //   · **写侧只剩一处**：`submit` 走 room.post（第 17 刀），room 事件流里那部分由本层渲染。
    const [roomMeta, setRoomMeta] = createSignal<Room | null>(null);
    /** room 事件流里**该由本页画**的那些（say + reply，已按 opsOwnsEvent 过滤） */
    const [roomFeed, setRoomFeed] = createSignal<RoomEvent[]>([]);
    /** room 侧读失败：只影响「别人说的话」这一层，**不动**本会话的错误位（会话本身是好的） */
    const [roomNote, setRoomNote] = createSignal<string | null>(null);

    /** 主人格 member id：以房间成员表为准（缺则退回契约常量 —— 正常房间恒有它） */
    const mainMemberId = (room: Room | null): string =>
        room?.members.find((m) => m.main === true)?.id ?? MAIN_MEMBER_ID;

    /**
     * 右栏（成员栏）的**默认开合**（##166 §44.1 ②）：除主人格外还有 agent 成员 ⇒ 默认展开；
     * 只有主人格（人成员不计）⇒ 默认收起
     * （单人任务因此与改动前逐字一致 —— §43.3 C 判据 7 的原意）。
     *
     * 两条边界：
     *   · **用户表过态就彻底停手**（`layoutStore.userTouched`：点过开合按钮 / 拖过线都算）；
     *   · **每次进任务都按当前任务重算**（布局是**页级**的，所有任务 tab 共享一份 —— 只设一次的话
     *     "打开过多人任务"会把单人任务的右栏也顶出来）。故走 `setAreaHiddenAuto`（不置 userTouched）。
     */
    const applyRosterAuto = (room: Room | null): void => {
        const page = props.rosterAutoFor;
        if (!page || !room || layoutStore.userTouched(page)) return;
        // ⚠️「成员 > 1」= 除主人格之外**还有 agent 成员** —— **人成员不计**（否则单人任务
        // = 人 + 主人格 = 2 条也会展开，判据 7「单人任务逐字不变」当场破；实测踩过）。
        const otherAgents = room.members.filter((m) => m.kind === "agent" && m.main !== true).length;
        layoutStore.setAreaHiddenAuto(page, "right", otherAgents === 0);
    };

    /**
     * 软轮询的**引用稳定器**（##377 第 19 刀）：内容没变就不换引用。
     *
     * 为什么必须做：`roomFeed` 每 2.5s 换一次引用 ⇒ `roomRows → allRows → rowKeys → layout`
     * 整条 memo 链重算 ⇒ 下游**视口锚定 effect** 被惊动 ⇒ 视口被甩到账面顶再校正回来。
     * 实测（用户报的「任务会话时不时跳到某处」）：有 room 行的任务，视口每 2.5s 从
     * 用户位置弹到 +1885px 再弹回；把 room 事件清空后 13 秒纹丝不动 ⇒ 因果坐实。
     */
    const feedSig = (es: RoomEvent[]): string =>
        es.map((e) =>
            // `turnId` 也进签名（##377 第 29 刀）：它是**读侧投影**，投递当下没有、队列项落位后才算得出来 ——
            // 不进签名的话轮询永远认作"没变"，那条 say 的「回复在那一轮」入口就不会出现。
            `${e.id}:${(e.deliveries ?? []).map((d) => `${d.memberId}=${d.status}=${d.turnId ?? ""}`).join(",")}:${e.error ?? ""}`,
        ).join("|");
    const roomSig = (r: Room | null): string =>
        r === null ? "none" : `${r.focus ?? ""}#${r.members.map((m) => `${m.id}:${m.name}:${m.main === true ? "main" : ""}`).join(",")}`;
    let prevFeedSig: string | null = null;
    let prevRoomSig: string | null = null;

    const loadRoomFeed = async (u: string, soft = false): Promise<void> => {
        try {
            const r = await diyService.diy.room.get({ id: u, limit: 200 });
            const rs = roomSig(r.room);
            if (rs !== prevRoomSig) {
                prevRoomSig = rs;
                setRoomMeta(r.room);
                applyRosterAuto(r.room);
            }
            const mid = mainMemberId(r.room);
            const shown = r.events.filter((e) => !opsOwnsEvent(e, mid));
            const fs = feedSig(shown);
            if (fs !== prevFeedSig) {
                prevFeedSig = fs;
                setRoomFeed(shown);
            }
            if (!soft) setRoomNote(null);
        } catch (e) {
            if (!soft) setRoomNote(`读房间失败：${e instanceof Error ? e.message : String(e)}`);
        }
    };

    /** 输入框补全源（**memo 稳引用**：`memberCompletion` 每次调用返回新函数，见 MdEditor 的 prop 注释） */
    const chatCompletions = createMemo(() => [
        memberCompletion(() => roomMeta()?.members ?? []),
        taskCompletion,
    ]);

    /**
     * 外部行（key = `room:<事件 id>`）—— **按 id 复用行对象**：`<For>` 按引用 diff，
     * 轮询每 2.5s 给一批新事件对象，不复用就会把外部行每轮重建（展开态跟着丢）。
     * `tsMs` 取事件的 ISO 时刻（同一事件不变 ⇒ 复用安全）。
     */
    let prevRoomRows: { key: string; tag: string; tsMs: number }[] = [];
    const roomRows = createMemo(() => {
        const byKey = new Map(prevRoomRows.map((r) => [r.key, r]));
        prevRoomRows = roomFeed()
            .map(
                (e) =>
                    byKey.get(`room:${e.id}`) ??
                    { key: `room:${e.id}`, tag: e.kind === "say" ? "room-say" : "room-reply", tsMs: Date.parse(e.ts) },
            )
            .filter((r) => Number.isFinite(r.tsMs))
            .sort((a, b) => a.tsMs - b.tsMs);
        return prevRoomRows;
    });

    const roomEventOf = (key: string): RoomEvent | null =>
        roomFeed().find((e) => `room:${e.id}` === key) ?? null;

    /** 外部行的展开态（**页面级**：虚拟化摘行会卸载组件，放组件里会丢 —— 见 RoomReplyRow 头注） */
    const [replyOpen, setReplyOpen] = createSignal<Record<string, boolean>>({});
    /** 「忙时插话 → 那一轮」的展开态（key = `<sayId>:<memberId>`；与 reply 行同一条理由） */
    const [steerOpen, setSteerOpen] = createSignal<Record<string, boolean>>({});

    // 取数：首挂 + 切任务 + 2.5s 轻量轮询（与侧边栏同一节奏；本切片无推送通道）
    onMount(() => {
        const u0 = uri();
        if (u0) void loadRoomFeed(u0);
        const t = setInterval(() => {
            const u = uri();
            if (u) void loadRoomFeed(u, true);
        }, 2500);
        onCleanup(() => clearInterval(t));
    });
    createEffect(
        on(uri, (u) => {
            if (u) void loadRoomFeed(u);
        }),
    );

    let prevRows: { key: string; tag: string }[] = [];
    const rootRows = createMemo(() => {
        const byKey = new Map(prevRows.map((r) => [r.key, r]));
        prevRows = localChatStore.trees.map((t) => {
            const old = byKey.get(t.id);
            return old && old.tag === t.tag ? old : { key: t.id, tag: t.tag };
        });
        return prevRows;
    });

    return {
        roomMeta,
        setRoomMeta,
        roomFeed,
        setRoomFeed,
        roomNote,
        setRoomNote,
        mainMemberId,
        applyRosterAuto,
        feedSig,
        roomSig,
        prevFeedSig,
        prevRoomSig,
        loadRoomFeed,
        chatCompletions,
        prevRoomRows,
        roomRows,
        roomEventOf,
        replyOpen,
        setReplyOpen,
        steerOpen,
        setSteerOpen,
        prevRows,
        rootRows,
    };
}

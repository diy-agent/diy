// src/main/services/room-context.ts — **房间 → 上下文变量单元**（##377 第 25/26 刀）
//
// 病灶（owner 口径 ②：「可用性收口」里最硬的那条，§28.7A 的残留）：
//   第 18 刀的「本房间近期发言」只在**被投递**时注入（`room-service.deliverOne` → `deliveryText`）。
//   成员**自己起一轮**（任务页点跑 / 定时任务 / CLI 一句话）时读不到房间刚才聊了什么
//   ⇒ 它不知道自己在跟谁说话 —— 而这恰恰是"人 + 多 agent 同室"最平常的用法。
//
// 第 26 刀把落点从「拼进 user 正文」搬成 **runtime 变量单元**（`room.members` / `room.recent`）：
//   · 正文是**发送时刻快照**且**进会话历史**（压缩模型会当人话改写、回放分不清谁说的）；
//   · runtime 是**带类型的 YAML 信封**（每轮现拼、按 place 增量、压缩/回放可按类型识别与丢弃）。
//   · 两条路径（自起 / 投递）因此**同一处产出**，不必"同一判据 + 两处拼装"。
//
// 四条判据**不在这里**（全在 `shared/room.roomContextFor`：水位 / 去重 / 不看自己 / 上限）——
// 这里只负责「读哪间房、算谁的、值长什么样」。
//
// 水位为什么在成轮之后才前移：与投递路径同一条口径（「成功后才前移，宁可重复不可漏」）。
// 崩在注入与成轮之间 = 水位没动 ⇒ 下一轮再注入一遍（多几十到几百字），不会静默丢失。

import { advanceLastSeen, readEvents, readRoom } from "../core/room";
import {
    roomContextFor,
    roomMembersValue,
    roomRecentValue,
    type RoomMembersValue,
    type RoomRecentValue,
} from "../../shared/room";

/**
 * 读事件流时的**尾部窗口**（行）—— 只为了答「最近谁说了什么」。
 *
 * 为什么要一个数：`roomContextFor` 的上限是 20 条 / 4000 字符，而事件流会无限增长（##427）。
 * 给 500 行是**保守取的大值**（远超 20 条，且单行很长的房间也绰绰有余），代价仍是「只读文件尾
 * 一两块」。
 *
 * ⚠ 副作用：水位（`lastSeenId`）若落在窗口之外，`roomContextFor` 按「从头看」处理
 * （它本来就对「找不到水位」这么兜）—— 结果仍是「最近 20 条」，与全量读**逐字一致**；
 * 差别只在 `omitted` 计数（窗口外的不再计入），不影响注入内容。
 */
const ROOM_CONTEXT_READ_LINES = 500;

/** `runtime.room` 的值（两个**原子单元**：`room.members` 低频 / `room.recent` 高频） */
export interface RoomRuntimeValue {
    members: RoomMembersValue;
    /** 没有可注入的发言（水位已到末尾 / 只有自己的话）⇒ **整个单元缺席**，不占字节也不砸缓存 */
    recent?: RoomRecentValue;
}

export interface RoomRuntimeFact {
    value: RoomRuntimeValue;
    /** 本次覆盖到的最后一条事件 id（水位前移的落点；**投递轮不在这里前移**，见下） */
    tailId: string;
    /** 算谁的水位（房间里绑这个 task 的成员；缺省 = 主人格） */
    memberId: string;
    /** 这一轮看的是哪间房（自起 = 本任务自己的房间；投递 = **来源**房间） */
    roomId: string;
    /** 实际带进来的条数（判据 / 日志用） */
    items: number;
    /** 因上限没带进来的条数（>0 ⇒ `room.recent.omitted`） */
    omitted: number;
}

/**
 * 算「这一轮该看到的房间上下文」。
 *
 * 返回 `null` 的三种情形（都意味着**运行时上下文逐字不变** —— 单人任务 / 没开过房间的老任务照旧）：
 *   ① 房间不存在（这个任务从没被打开过任务页、也没被投递过）
 *   ② 房间里没有能对上这个 task 的成员（老房间 / 极端数据）
 *   ③ 读数抛错（调用方兜住，本轮照常发）
 *
 * `sayId`：投递轮传「正文里那一条」，避免同一句话既在正文又在 recent 里出现一次。
 */
export async function roomRuntimeFact(opts: { roomId: string; taskUri: string; sayId?: string }): Promise<RoomRuntimeFact | null> {
    const { roomId, taskUri, sayId } = opts;
    const room = readRoom(roomId);
    if (!room) return null;
    // 成员判据 = 「谁的会话是这个 task」：先按 backend 精确对上，再退主人格。
    // （投递轮里收件人可能**不是**主人格 —— 它是被邀请进来、绑在自己任务上的那个成员。）
    const bound = (m: (typeof room.members)[number]): boolean =>
        m.backend?.type === "task" && m.backend.data.taskUri === taskUri;
    const self = room.members.find((m) => bound(m) && m.main === true) ?? room.members.find(bound) ?? room.members.find((m) => m.main === true);
    if (!self) return null;
    // 只要"最近谁说了什么"（`roomContextFor` 最多吐 `CONTEXT_MAX_EVENTS` 条 / 4000 字符）⇒
    // 倒读尾部一窗就够了（##427：旧实现为这句话把整条事件流读了一遍，5 MB 时是轮首一次 ~60 ms 的同步阻塞）。
    const { events } = await readEvents(roomId, { limit: ROOM_CONTEXT_READ_LINES });
    const ctx = roomContextFor({
        events,
        memberId: self.id,
        // 自起没有"本次投递的那条 say" ⇒ 空串（`roomContextFor` 只拿它做排除，空串不命中任何事件）
        sayId: sayId ?? "",
        lastSeenId: room.lastSeen[self.id],
    });
    const value: RoomRuntimeValue = { members: roomMembersValue(room) };
    // 空 recent ⇒ **不出这个单元**（只有成员表）：省字节、也让「没人说话」不产生高频 diff
    if (ctx.items.length > 0) value.recent = roomRecentValue(room, ctx.items, ctx.omitted);
    return {
        value,
        tailId: events.length > 0 ? events[events.length - 1]!.id : "",
        memberId: self.id,
        roomId,
        items: ctx.items.length,
        omitted: ctx.omitted,
    };
}

/**
 * 前移水位到「本次覆盖到的最后一条」。
 *
 * `advanceLastSeen` **永不 reject**（##377 第 18 刀 P1：写盘失败不许把投递 / 轮次搞挂）——
 * 这里连 `catch` 都不用再加，丢一次最坏是下一轮重复注入。
 *
 * ⚠ **只给自起轮用**：投递轮的水位归 `room-service`（它按 `sayId` 前移，与投递状态同生共死）。
 *   两边都前移的话，后一次会把水位**往回拨**（`roomContextFor` 按流内位置定位）⇒ 重复注入。
 */
export function commitSelfStartContext(roomId: string, fact: RoomRuntimeFact): void {
    if (!fact.tailId) return;
    void advanceLastSeen(roomId, { [fact.memberId]: fact.tailId });
}

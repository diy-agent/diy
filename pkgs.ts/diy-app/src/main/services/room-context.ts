// src/main/services/room-context.ts — **轮首**房间上下文（##377 第 25 刀）
//
// 病灶（owner 口径 ②：「可用性收口」里最硬的那条，§28.7A 的残留）：
//   第 18 刀的「本房间近期发言」只在**被投递**时注入（`room-service.deliverOne` → `deliveryText`）。
//   成员**自己起一轮**（任务页点跑 / 定时任务 / CLI 一句话）时读不到房间刚才聊了什么
//   ⇒ 它不知道自己在跟谁说话 —— 而这恰恰是"人 + 多 agent 同室"最平常的用法。
//
// 本模块 = 「轮首也注入」的**唯一落点**：把这个任务的房间里「自上次以来别人说了什么」
// 算成一段可拼进 user 正文的文本，并给出**水位前移**的落点。
//
// 四条判据**不在这里**（全在 `shared/room.roomContextFor`：水位 / 去重 / 不看自己 / 上限）——
// 这里只负责「读哪间房、算谁的、用谁的名字显示」，与投递路径共用同一份判据。
//
// 与投递路径的分工（**别两边都注入**）：
//   · 投递（`room-service`）→ 正文已由 `deliveryText` 带同一段（第 18 刀）⇒ 本条**不再注入**
//     （判据在 `local-agent.driveTurn` 的 `isDelivery`）
//   · 自起（`local-agent`）→ 正文尾部拼本模块给的段，**成轮之后**前移水位
//
// 水位为什么在成轮之后才前移：与投递路径同一条口径（「成功后才前移，宁可重复不可漏」）。
// 崩在注入与成轮之间 = 水位没动 ⇒ 下一轮再注入一遍（多几十到几百字），不会静默丢失。

import { advanceLastSeen, readEvents, readRoom } from "../core/room";
import { contextBlock, memberName, roomContextFor } from "../../shared/room";

export interface SelfStartContext {
    /** 可直接拼到 user 正文后面的文本（已含 `[本房间近期发言]` 段头 / 省略标注） */
    text: string;
    /** 本次注入覆盖到的最后一条事件 id（水位前移的落点） */
    tailId: string;
    /** 算谁的水位（房间里 `main === true` 的成员 = 这个任务的会话主人） */
    memberId: string;
    /** 实际带进来的条数（判据 / 日志用） */
    items: number;
    /** 因上限没带进来的条数（>0 ⇒ 文本末尾有「更早的 N 条已省略」） */
    omitted: number;
}

/**
 * 算「这个任务的房间里，自上次以来**别人**说了什么」。
 *
 * 返回 `null` 的四种情形（都意味着**正文逐字不变** —— 单人任务 / 没开过房间的老任务照旧）：
 *   ① 房间不存在（这个任务从没被打开过任务页、也没被投递过）
 *   ② 房间里没有主人格（老房间 / 极端数据）
 *   ③ 事件流是空的
 *   ④ 算出来没有可注入的条目（水位已到末尾 / 只有自己的话 / 全是空正文）
 */
export function selfStartContext(roomId: string): SelfStartContext | null {
    const room = readRoom(roomId);
    if (!room) return null;
    // 主人格 = 拥有「这个 task 的会话」的那个成员（与投递路径 `deliverOne` 的 owner 同一条判据）
    const self =
        room.members.find((m) => m.main === true && m.backend?.type === "task" && m.backend.data.taskUri === roomId) ??
        room.members.find((m) => m.main === true);
    if (!self) return null;
    const { events } = readEvents(roomId);
    if (events.length === 0) return null;
    const ctx = roomContextFor({
        events,
        memberId: self.id,
        // 自起没有"本次投递的那条 say" ⇒ 给空串（`roomContextFor` 只拿它做排除，空串不命中任何事件）
        sayId: "",
        lastSeenId: room.lastSeen[self.id],
    });
    const block = contextBlock(ctx.items, ctx.omitted, (id) => memberName(room, id));
    // 上下文为空 ⇒ 返回 null（而不是空串）：调用方据此**不动正文**（第 17 刀判据 1/7 的回归网）
    if (!block) return null;
    return {
        text: block,
        tailId: events[events.length - 1]!.id,
        memberId: self.id,
        items: ctx.items.length,
        omitted: ctx.omitted,
    };
}

/**
 * 前移水位到「本次注入覆盖到的最后一条」。
 *
 * `advanceLastSeen` **永不 reject**（##377 第 18 刀 P1：写盘失败不许把投递 / 轮次搞挂）——
 * 这里连 `catch` 都不用再加，丢一次最坏是下一轮重复注入。
 */
export function commitSelfStartContext(roomId: string, ctx: SelfStartContext): void {
    if (!ctx.tailId) return;
    void advanceLastSeen(roomId, { [ctx.memberId]: ctx.tailId });
}

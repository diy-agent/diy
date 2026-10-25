// src/main/services/inbox-sweep.ts
// 🎯 启动扫尾：把「已经不可能再送到」的投递 / 队列**落成信箱条目**（##436 顺带治的两个洞）。
//
// 治的两个洞（t266.room#queues 记的账）：
//   ① zombie 投递 —— 某条 say 因成员队列 `depth>1` 停在 `queued`，进程重启后内存里的执行链
//      没了，`deliveries.jsonl` 里那条永远停在 `queued`：没有 agent 会看到那句话。
//   ② 永不消费的队列 —— 会话已**终态**（done / cancelled / closed，`shared/turn-gate` 的共享
//      词表），`.diy/drafts.yaml` 里却还压着待投递插话：**没有下一次轮次来取走它们**。
//
// 两条都只做**记账**：不改投递、不重投、不动队列（本轮三条硬约束）；但**不许静默** ——
// 用户至少能在上边栏信箱里读到「哪句话没送到」。
//
// 为什么在启动时扫而不是常驻轮询：「进程重启过」本身就是这两件事的判据 —— 内存里的执行链
// 只活在进程里，重启那一刻链就已经没了。常驻轮询既读不出这个事实，又白烧 IO。
//
// 幂等：同一件事重启十次不许留十条。判据 = 信箱里已有的同类条目（`data.dedupeKey`），
// 不是进程内 flag —— 后者只能挡住同一进程内的两次调用。

import { readDrafts } from "../core/drafts";
import { listRooms, readDeliveries, readEvents } from "../core/room";
import { getTask } from "../core/state";
import { listTasks } from "../core/task";
import { isTerminalSessionState } from "../../shared/turn-gate";
import type { DeliveryStatus } from "../../shared/room";
import { inboxEntryOf, inboxHub, lostDeliveryEntryOf, stuckQueueEntryOf } from "./inbox";

/** 停在这两个状态 = 没跑完；进程重启后再没有人会推进它们 */
const NON_TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>(["queued", "running"]);

/** 这条投递的收件会话（`mark()` 会带上 `taskUri`；老记录没有就回成员表里查一次） */
function taskUriOf(
    d: { taskUri?: string; memberId: string },
    room: { members: ReadonlyArray<{ id: string; backend?: { type: string; data?: unknown } | null }> },
): string {
    if (d.taskUri) return d.taskUri;
    const member = room.members.find((m) => m.id === d.memberId);
    const data = member?.backend && member.backend.type === "task" ? (member.backend.data as { taskUri?: string } | undefined) : undefined;
    return data?.taskUri ?? "";
}

/** 已经落过这件事的条目了吗（幂等判据：`data.dedupeKey`） */
function alreadyNoted(
    existing: ReadonlyArray<{ kind: string; data?: Record<string, string | number | boolean | null> }>,
    key: string,
): boolean {
    return existing.some((e) => e.kind === "delivery-lost" && e.data?.["dedupeKey"] === key);
}

/**
 * 扫所有房间的投递账 → 停摆的落条目。返回新落的条数（0 = 没有僵尸账）。
 *
 * 为什么要回事件流里捞原文：`deliveries.jsonl` 只有 `eventId`，原话在 `events.jsonl` 的
 * `say` 事件里 ——「丢了什么」必须能读，否则这条记录又是一句形容词。
 */
export async function sweepLostDeliveries(): Promise<number> {
    const existing = await inboxHub.list();
    let noted = 0;
    for (const room of listRooms()) {
        const { byEvent } = await readDeliveries(room.id);
        if (byEvent.size === 0) continue;
        const stalled = [...byEvent.entries()].flatMap(([eventId, members]) =>
            [...members.values()].filter((d) => NON_TERMINAL.has(d.status)).map((d) => ({ eventId, d })),
        );
        if (stalled.length === 0) continue;
        // 事件流只在真有僵尸账时才读（大多数房间没丢东西，别为它们解析整条流）
        const { events } = await readEvents(room.id);
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const { eventId, d } of stalled) {
            const taskUri = taskUriOf(d, room);
            if (!taskUri) continue; // 没有会话可跳 ⇒ 条目里的「去来源」会是假按钮（与 navTargetOf 同一取向）
            const key = `${room.id}|${eventId}|${d.memberId}`;
            if (alreadyNoted(existing, key)) continue;
            const ev = byId.get(eventId);
            await inboxHub
                .push(
                    inboxEntryOf(
                        lostDeliveryEntryOf({
                            taskUri,
                            roomId: room.id,
                            sayId: eventId,
                            memberId: d.memberId,
                            status: d.status,
                            dedupeKey: key,
                            ...(ev?.text ? { text: ev.text } : {}),
                            ...(d.ts ? { ts: d.ts } : {}),
                        }),
                    ),
                )
                .catch((e: unknown) => console.error("[inbox-sweep] 落僵尸投递条目失败:", e));
            noted++;
        }
    }
    return noted;
}

/**
 * 扫**终态任务**的插话队列 → 永不投递的那些落条目。
 *
 * 判据刻意保守，只有一条：任务状态是终态（`shared/turn-gate` 的词表）且 `.diy/drafts.yaml`
 * 里还有 `steers`。终态会话不再接受新轮次 ⇒ 没有下一次「轮末整批取走」⇒ 这些留言永不投递。
 *
 * 为什么不把「非终态但很久没跑」也算上：那是**猜测**（用户随时可能点跑）。猜错的代价是假警报
 * 刷屏 —— 正是 ##435 在治的病。
 */
export async function sweepStuckQueues(): Promise<number> {
    const existing = await inboxHub.list();
    let noted = 0;
    for (const uri of listTasks()) {
        const task = getTask(uri);
        if (!task || !isTerminalSessionState(task.state)) continue;
        const steers = readDrafts(uri)?.steers ?? [];
        if (steers.length === 0) continue;
        const key = `${uri}|queue`;
        if (alreadyNoted(existing, key)) continue;
        await inboxHub
            .push(
                inboxEntryOf(
                    stuckQueueEntryOf({
                        taskUri: uri,
                        state: task.state,
                        dedupeKey: key,
                        steers: steers.map((s) => ({
                            id: s.id,
                            text: s.text,
                            created: s.created,
                            ...(s.author ? { author: s.author } : {}),
                        })),
                    }),
                ),
            )
            .catch((e: unknown) => console.error("[inbox-sweep] 落永不投递队列条目失败:", e));
        noted++;
    }
    return noted;
}

let swept = false;

/**
 * 启动扫尾的唯一入口（`main/index.ts` 的 `whenReady` 调一次）。
 *
 * 失败全部吞掉并留痕：扫尾是**记账**，它坏了不该阻止应用起来（与 `inboxHub.push` 同一取向）。
 * 进程内只跑一次（`swept`）；跨进程的幂等判据在盘上那层（`dedupeKey`）。
 */
export async function sweepInboxOnStartup(): Promise<{ lost: number; stuck: number }> {
    if (swept) return { lost: 0, stuck: 0 };
    swept = true;
    let lost = 0;
    let stuck = 0;
    try {
        lost = await sweepLostDeliveries();
    } catch (e) {
        console.error("[inbox-sweep] 僵尸投递扫尾失败（不影响启动）:", e);
    }
    try {
        stuck = await sweepStuckQueues();
    } catch (e) {
        console.error("[inbox-sweep] 永不投递队列扫尾失败（不影响启动）:", e);
    }
    if (lost + stuck > 0) {
        console.warn(`[inbox-sweep] 启动扫尾：僵尸投递 ${lost} 条 / 永不投递队列 ${stuck} 个任务（详见信箱）`);
    }
    return { lost, stuck };
}

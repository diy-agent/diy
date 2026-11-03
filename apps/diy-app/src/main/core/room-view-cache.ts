// src/main/core/room-view-cache.ts —— room 视图的**读盘合并**（##427）
//
// 病根：UI 里有多个组件各自 `setInterval(2500)` 打 `room.get` / `room.roster`（`SidebarRoom` /
// `RoomsPage` / `LocalRoom` / `TaskRoomRoster`），同一个房间在一次刷新窗口里被**读好几遍盘**；
// 而且每次都要从头解析整条事件流。
//
// 判据（为什么不是 TTL 缓存）：轮询要的是「盘上现在是什么」，TTL 会把**刚发的消息**藏起来
// 最多一个 TTL（发完立刻刷反而看到旧的 ⇒ 看起来像"发了没反应"）。所以这里用**文件签名**做失效：
//   · 签名 = 三个文件（room.yaml / events.jsonl / deliveries.jsonl）的 `(size, mtimeMs)`；
//     任一份变了 ⇒ 以前那份一定不算数（append-only 流**只会变长**，size 就是最硬的判据）。
//   · 没变 ⇒ 直接复用上次那份（同一 roomId 在 2.5s 内的第二个订阅者**零读盘**，可测：
//     `core/room.roomReadStats()` 的计数不动）。
//
// 窗口合并：不同调用方要的 `limit` 不同（`TaskRoomRoster` 只要 1 条、时间线要 200/300）。
// 缓存里存**已知最大窗口**那份；要更小的窗口就从它 `slice` 尾部（尾部 N 条与直接读 N 条等价），
// 要更大的窗口或全量（`limit: 0`）才重读。

import { stat } from "node:fs/promises";
import {
    readDeliveries,
    readRoomView,
    roomDeliveriesPath,
    roomEventsPath,
    roomYamlPath,
    type RoomView,
} from "./room";
import type { DeliveryState } from "../../shared/room";

interface ViewEntry {
    /** 文件签名（变了 = 盘上真变了） */
    sig: string;
    /** 这份缓存覆盖的事件窗口（0 = 全量） */
    limit: number;
    view: RoomView;
}

const viewCache = new Map<string, ViewEntry>();
/** 正在读的（同一房间的并发请求共享**同一个** promise —— 两个组件同时刷新只读一次盘） */
const inflight = new Map<string, { limit: number; promise: Promise<RoomView> }>();
const MAX_ENTRIES = 200;

async function sigOf(file: string): Promise<string> {
    try {
        const st = await stat(file);
        return `${st.size}:${st.mtimeMs}`;
    } catch {
        return "-"; // 不存在也是一个状态（建出来就会变）
    }
}

async function roomSig(roomId: string): Promise<string> {
    const parts = await Promise.all([sigOf(roomYamlPath(roomId)), sigOf(roomEventsPath(roomId)), sigOf(roomDeliveriesPath(roomId))]);
    return parts.join("|");
}

/** 缓存里那份（`cachedLimit`）够不够答 `want`（0 = 全量，只有全量能答） */
function covers(cachedLimit: number, want: number): boolean {
    if (cachedLimit === 0) return true;
    return want > 0 && cachedLimit >= want;
}

/** 从更大的窗口裁出 `want`（0 原样返回） */
function shape(view: RoomView, want: number): RoomView {
    if (want <= 0 || view.events.length <= want) return view;
    return { ...view, events: view.events.slice(view.events.length - want) };
}

function put(roomId: string, entry: ViewEntry): void {
    const prev = viewCache.get(roomId);
    // 已有更大的窗口（同一签名）就留着它 —— 大窗口能答小窗口，反之不行
    if (prev && prev.sig === entry.sig && covers(prev.limit, entry.limit)) return;
    viewCache.set(roomId, entry);
    while (viewCache.size > MAX_ENTRIES) {
        const first = viewCache.keys().next();
        if (first.done) break;
        viewCache.delete(first.value);
    }
}

/**
 * 读房间视图（带**文件签名缓存** + 并发合并）。语义与 `readRoomView` 一致，只是同一份盘
 * 在没变化时不会读第二遍。返回值**只读**（缓存共享，调用方别原地改 `room` / `events`）。
 */
export async function readRoomViewCached(roomId: string, opts: { limit?: number } = {}): Promise<RoomView> {
    const want = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 0;
    const sig = await roomSig(roomId);
    const hit = viewCache.get(roomId);
    if (hit && hit.sig === sig && covers(hit.limit, want)) return shape(hit.view, want);

    const flying = inflight.get(roomId);
    if (flying && covers(flying.limit, want)) return shape(await flying.promise, want);

    const promise = readRoomView(roomId, { limit: want }).then((view) => {
        put(roomId, { sig, limit: want, view });
        return view;
    });
    inflight.set(roomId, { limit: want, promise });
    try {
        return shape(await promise, want);
    } finally {
        const cur = inflight.get(roomId);
        if (cur && cur.promise === promise) inflight.delete(roomId);
    }
}

// ─── 投递状态（`room.roster` 只要状态，不要事件）───────────────────────

interface DeliveriesEntry {
    sig: string;
    value: { byEvent: Map<string, Map<string, DeliveryState>>; bad: number };
}
const deliveriesCache = new Map<string, DeliveriesEntry>();
const deliveriesInflight = new Map<string, Promise<DeliveriesEntry["value"]>>();

/**
 * 读投递状态（**只按 deliveries.jsonl 签名**缓存；整份 fold 要扫全文件，却是纯函数式的
 * 「最新状态」，可以放心复用）。同样合并并发。
 */
export async function readDeliveriesCached(
    roomId: string,
): Promise<{ byEvent: Map<string, Map<string, DeliveryState>>; bad: number }> {
    const sig = await sigOf(roomDeliveriesPath(roomId));
    const hit = deliveriesCache.get(roomId);
    if (hit && hit.sig === sig) return hit.value;
    const flying = deliveriesInflight.get(roomId);
    if (flying) return await flying;
    const promise = readDeliveries(roomId).then((value) => {
        deliveriesCache.set(roomId, { sig, value });
        while (deliveriesCache.size > MAX_ENTRIES) {
            const first = deliveriesCache.keys().next();
            if (first.done) break;
            deliveriesCache.delete(first.value);
        }
        return value;
    });
    deliveriesInflight.set(roomId, promise);
    try {
        return await promise;
    } finally {
        if (deliveriesInflight.get(roomId) === promise) deliveriesInflight.delete(roomId);
    }
}

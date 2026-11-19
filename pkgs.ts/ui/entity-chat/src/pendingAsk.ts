/**
 * 侧栏 `?`（还有几个提问在等我答）的合并规则。
 *
 * 两个来源，优先级不是「谁更新」，而是按**这份数字还准不准**排：
 *
 * 1. 正在看的房间：会话流说了算。流是常驻 SSE，答完那一刻 gate 就结算了；`/rooms` 投影
 *    最短也要等下一轮轮询（30 秒），用它会把「刚答完的提问」又点亮一阵。
 * 2. 其余一律以服务端投影为准 —— **包括看过的房间**。切走时那条订阅会被摘掉
 *    （`conversationOf().dispose()` → `release`），本地这份从此不再更新；再继续本地优先的话，
 *    提问在别处有了结局之后 `?` 会一直亮着，服务端的 0 永远盖不回去。
 *
 * 交给流的前提是「流已经来过一份快照」（调用方传 `liveRoomId` 时才成立）：刚
 * `conversationOf()` 时 asks 还是空的（快照在路上），拿这份空数组盖服务端会让 `?` 先灭再亮。
 */
export function mergePendingAsks(
    server: Record<string, number>,
    local: Record<string, number>,
    /** 流在手、且已热身的房间 id；`''` = 没有这样的房间 */
    liveRoomId: string,
): Record<string, number> {
    const merged: Record<string, number> = {};
    for (const [id, count] of Object.entries(server)) {
        if (count > 0) merged[id] = count;
    }
    if (liveRoomId === '') return merged;
    const count = local[liveRoomId] ?? 0;
    if (count > 0) merged[liveRoomId] = count;
    else delete merged[liveRoomId];
    return merged;
}

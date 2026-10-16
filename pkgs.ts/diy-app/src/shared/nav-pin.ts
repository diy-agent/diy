// src/shared/nav-pin.ts
// 🎯 nav「任务置顶」的**纯规则**（##356 ②）：谁算置顶、置顶怎么排、垃圾键怎么清。
//
// 为什么单独成文件：置顶的判据（区内保序、只由用户动作改写集合）是可判定的规则，
// 塞进 App.tsx 的 nav 渲染里就只剩「界面上看着对」一种验证（tests/core/nav-pin.test.ts 用得上）。
// 无 DOM、无 Node、无 solid 依赖 —— 持久化在 renderer 侧（store/navPinStore）。

/**
 * 按置顶集合把列表**分区**（不排序）。
 *
 * 两条刻意的不变量：
 *  1. **区内保持输入顺序**：置顶区里的相对顺序 = 全局顺序（nav 里就是任务的树序），
 *     故置顶不会让父子相邻关系在区内错乱。
 *  2. **只分区、不隐式扩集合**：祖先不因子孙被置顶而跟着置顶（集合只由用户动作改写）。
 *
 * @param pinned 置顶键集合（不是数组：顺序由 items 决定，不由集合决定）
 */
export function partitionByPin<T>(
    items: readonly T[],
    keyOf: (t: T) => string,
    pinned: ReadonlySet<string>,
): { pinned: T[]; rest: T[] } {
    const p: T[] = [];
    const r: T[] = [];
    for (const it of items) (pinned.has(keyOf(it)) ? p : r).push(it);
    return { pinned: p, rest: r };
}

/** 切换某个键的置顶态（返回新数组，不改原数组） */
export function togglePin(pinned: readonly string[], key: string): string[] {
    return pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key];
}

/**
 * 剪掉**已不存在的**置顶键（tab 关了 / 任务被删）。
 *
 * 语义边界：这里只管「键还在不在」，**不管它现在指什么** —— 集合是视图偏好，
 * 任务重开时同 key（`<pageId>:<ctx>`）自然又是置顶的（那正是用户要的）。
 */
export function prunePins(pinned: readonly string[], alive: readonly string[]): string[] {
    const set = new Set(alive);
    return pinned.filter((k) => set.has(k));
}

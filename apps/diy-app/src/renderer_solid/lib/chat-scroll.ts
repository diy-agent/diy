/**
 * chat-scroll — 聊天页**两个滚动决策**（纯函数，零 DOM，node 环境可单测）
 *
 * 为什么抽出来（##331）：本页的滚动语义踩过三次坑（##293 上滚补历史的位置补偿、
 * 直播跟随、切回恢复阅读位置），三次的毛病都是同一个 —— **用绝对像素表达"我在看哪儿"**。
 * 而本页的高度**已知不稳定**：`[data-turn-id]` 带 `content-visibility:auto` +
 * `contain-intrinsic-size:24rem`（没露过面的轮先按估算占位，布局后才换实测高度，
 * 见 LocalChatPage 里 loadOlderInto 的头注），于是同一像素在不同时刻指向不同内容。
 *
 * 这里只放**决策**（该不该滚、滚到哪），DOM 读写在组件里 —— 决策可单测，DOM 不可。
 */

import { leavesOf } from "./chat-fold";
import type { BlockNode } from "../../main/services/local-blocks";

/**
 * 文档序**最后一片叶子**的 id（跨全部轮）—— 滚动的"新块"判据（见 `followPlan`）。
 * 没有轮、或轮里一个叶子都没有 → null。step 之类纯容器由 `leavesOf` 向下递归剥掉。
 */
export function lastLeafId(trees: BlockNode[]): string | null {
    for (let i = trees.length - 1; i >= 0; i--) {
        const t = trees[i]!;
        if (t.tag !== "turn") continue;
        const ls = leavesOf(t);
        const last = ls[ls.length - 1];
        if (last) return last.id;
    }
    return null;
}

/** 视口**顶部**那个块的身份（+ 它在容器内的相对偏移，≤0 = 块顶被滚出容器顶）—— 恢复阅读位置用 */
export interface ChatAnchor {
    id: string;
    offset: number;
}

/** 跟随该做什么（见 `followPlan`） */
export type FollowPlan =
    /** 什么都不做：用户在读历史（不打扰）/ 同一块内流式增长（内容从下方长出） */
    | { kind: "idle" }
    /** 滚到底：首次进入会话 / 新块比视口矮（短块与 IM 直觉一致） */
    | { kind: "bottom" }
    /** 把新块的**首行**贴到视口顶：新块比视口高 —— 让用户从开头读，而不是钉在末行 */
    | { kind: "block-top"; blockTop: number };

/** scrollTop 的合法区间 [`0`, `scrollHeight - clientHeight`]（内容不满一屏时只能是 0） */
export function clampScrollTop(v: number, scrollHeight: number, clientHeight: number): number {
    const max = Math.max(0, scrollHeight - clientHeight);
    if (Number.isNaN(v)) return 0; // 几何量还没量到（NaN）→ 不许写进 scrollTop
    return Math.min(Math.max(0, v), max);
}

/**
 * 跟随时序（##331 ①）。
 *
 * 判据是**末叶子 id**（`lastLeafId`）而不是"高度变了"：本页改高度的东西太多
 * （手动展开过程块、切 MD/原文、窗口 resize），按高度判定会把它们全误读成"新内容"，
 * 表现为"用户在翻历史，被一把拽走"（既有代码的注释已记过这个教训 —— 那正是它用
 * `localChatStore.trees` 信号而不是 ResizeObserver 的原因，这里沿用同一判据）。
 *
 * 三态：
 *   · 末叶子**换了**（新块出现）→ 矮块 `bottom` / 高块 `block-top`。
 *   · 末叶子**没换**（同一块内流式增长）→ `idle`：不主动改 scrollTop，让它从屏幕下方长出
 *     （用户 2026-10-15 口径："新内容在屏幕下方自然延续，不主动滚屏"）。
 *   · 还没有末叶子（`prevTailId === null`，含"会话内容还没上屏"这一帧）→ `idle`。
 *     **不要在这里跟到底**：切会话时块树会短暂变成空树（open 先清段再填），
 *     若把 null 读成"首帧该看最新"，切回来就会被自己滚到底、把 restore 的定位顶掉
 *     （③ 就是这么复发过一次）。"初次进入看最新"归 `restore` 的 `gotoBottom`，
 *     那条路径判的是"有没有阅读锚点"，比"块树空不空"稳定得多。
 */
export function followPlan(opts: {
    /** 是否贴底（false = 用户正在上方读历史，一律不动） */
    stick: boolean;
    /** 上一帧的末叶子 id（null = 首帧 / 还没渲染过内容） */
    prevTailId: string | null;
    /** 本次的末叶子 id（null = 当前没有任何叶子） */
    tailId: string | null;
    /** 该块在内容坐标系里的顶（px） */
    blockTop: number;
    /** 该块的高（px） */
    blockHeight: number;
    /** 滚动容器可视高（px） */
    clientHeight: number;
}): FollowPlan {
    if (!opts.stick || !opts.tailId || opts.prevTailId === null) return { kind: "idle" };
    if (opts.prevTailId === opts.tailId) return { kind: "idle" };
    if (opts.blockHeight <= opts.clientHeight) return { kind: "bottom" };
    return { kind: "block-top", blockTop: opts.blockTop };
}

/**
 * 锚点恢复目标（##331 ③）：找回顾存那一刻"视口顶部那一行"。
 *
 * `blockTop` = 锚点块**现在**在内容坐标系里的顶（由 DOM 现量）；`offset` = 保存时块顶
 * 相对容器顶的偏移（≤0）。目标 = 让块顶重新落在离容器顶 `offset` 处。
 * 超界由 `clampScrollTop` 收口（内容被删/变矮时宁可停在边界，也不给出非法值）。
 */
export function anchorScrollTop(
    blockTop: number,
    offset: number,
    scrollHeight: number,
    clientHeight: number,
): number {
    return clampScrollTop(blockTop - offset, scrollHeight, clientHeight);
}

/** 锚点连校的跨帧状态（`anchorTick` 的输入输出） */
export interface AnchorTickState {
    /** 上一次我们**写下去**的 scrollTop（写后以实际值为准）。用来识别"这一帧的值不是我们写的" */
    lastSt: number;
    /** 已连续静默（无漂移）的帧数 */
    quiet: number;
    /** **latch**：已发现用户自己滚过 ⇒ 此后永不再校正（review1 R1） */
    userLeft: boolean;
}

export interface AnchorTickResult {
    /** 非 null = 该帧要写进 scrollTop 的值 */
    setTop: number | null;
    /** 下一帧的状态 */
    state: AnchorTickState;
    /** 是否收手（不再排下一帧） */
    stop: boolean;
}

/**
 * 锚点连校的**单帧决策**（##331 ③ · 纯函数，DOM 读写在组件里）。
 *
 * 三件事，按优先级：**用户接管 > 漂移校正 > 静默计数**。
 *
 * **latch 是必须的**（review1 R1 的 bug）：漂移校正是"相对基准"的 —— 若发现用户滚动只更新
 * 基准而不锁死，下一帧 `userScrolled` 又会变假（基准已被改写成用户的位置），drift 立刻把用户
 * **推回锚点**，与"绝不抢"正好相反：
 *
 *   | 帧 | scrollTop | lastSt | 判定 | 旧行为 | 本函数 |
 *   |---|---|---|---|---|---|
 *   | k（用户滚到 Y） | Y | X | 变过 | quiet=0，基准←Y | **latch，收手** |
 *   | k+1（停手） | Y | Y | 没变 | drift=X−Y ⇒ 推回 X ❌ | 已 latch，不动 ✅ |
 *
 * 所以：值与基准不符 ⇒ 认定用户接管 ⇒ 永久停止（`stop: true`），把控制权交还用户。
 *
 * `blockTop === null`（锚点块还没上屏 / 已被移除）：不动，只跟基准 —— 帧预算由调用点兜底（R3）。
 */
export function anchorTick(
    m: {
        /** 当前 scrollTop */
        scrollTop: number;
        /** 锚点块顶**当前**相对容器顶的偏移（屏幕坐标差，与坐标原点无关）；null = 该块不在 DOM 里 */
        blockOffset: number | null;
        /** 目标：锚点块顶相对容器顶的偏移（≤0 = 块顶被滚出容器顶） */
        offset: number;
        scrollHeight: number;
        clientHeight: number;
        /** 连续静默多少帧即算稳（组件传 3） */
        quietFrames: number;
    },
    st: AnchorTickState,
): AnchorTickResult {
    if (st.userLeft) return { setTop: null, state: st, stop: true };
    if (Math.abs(m.scrollTop - st.lastSt) > 1) {
        // 值不是我们写的 ⇒ 用户在滚。latch 并收手（R1：绝不把用户推回锚点）
        return { setTop: null, state: { lastSt: m.scrollTop, quiet: 0, userLeft: true }, stop: true };
    }
    if (m.blockOffset === null) {
        return { setTop: null, state: { lastSt: m.scrollTop, quiet: st.quiet, userLeft: false }, stop: false };
    }
    // 漂移 = 块顶**现在**在哪 - 我们希望它在哪。`blockOffset` 已把屏幕坐标之差算好，
    // 无需再减容器顶（**别**把"内容坐标系"和"屏幕坐标系"混进同一个差里 —— 那样差的是 scrollTop）。
    const drift = m.blockOffset - m.offset;
    if (Math.abs(drift) >= 1) {
        const top = clampScrollTop(m.scrollTop + drift, m.scrollHeight, m.clientHeight);
        return { setTop: top, state: { lastSt: top, quiet: 0, userLeft: false }, stop: false };
    }
    const quiet = st.quiet + 1;
    return { setTop: null, state: { lastSt: m.scrollTop, quiet, userLeft: false }, stop: quiet >= m.quietFrames };
}


// ─── 事件流（room 面板 / 房间页）的跟随态（##377 第 19 刀）─────────────────────
//
// 为什么需要它：这两处原先在**每次取数后**无条件 `streamRef.scrollTop = scrollHeight`，
// 而取数是每 2.5s 一次轮询 —— 用户往上翻，最多 2.5 秒就被拽回底部（实测：滚到中段
// 1.6s 后回到距底 0px），即用户报的「room 的会话根本无法翻越」。
//
// 语义与聊天页同一套（stick-to-bottom）：贴底 → 新事件自动到底；用户上滚 → 立刻停手，
// 只有**人自己发的消息**（force）才把视口请回底部。
// 判据抽在这里（纯函数、可单测）：**程序化写入也会触发 scroll 事件**，把它误判成
// "用户在滚"会让跟随态乱掉（聊天页第 15 刀同一坑：钉底循环第一帧就把自己关掉）。

/** 距底多少 px 内算「贴着底」（与聊天页同一取值） */
export const STICK_PX = 32;

export interface ScrollGeom {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

/** 是否已贴底（容差内即算底部，避免差 1px 永远跟不住） */
export function nearBottom(g: ScrollGeom, stickPx = STICK_PX): boolean {
    return g.scrollHeight - g.scrollTop - g.clientHeight <= stickPx;
}

/** 事件流的跟随态 */
export interface StreamFollowState {
    /** true = 贴底（新事件自动到底）；用户上滚 ⇒ false（此后绝不打扰） */
    stick: boolean;
    /** 我们刚写下的 scrollTop（豁免紧随的一次 scroll 事件；null = 没有待豁免的） */
    progWrite: number | null;
}

export const streamFollowInit: StreamFollowState = { stick: true, progWrite: null };

/** 我们主动钉底之后的新状态：贴底 + 记下豁免位（紧随的那次 scroll 事件不算"人滚的"） */
export function pinnedTo(top: number): StreamFollowState {
    return { stick: true, progWrite: top };
}

/**
 * 一帧 scroll 事件 → 新跟随态。**只有"人滚的"才改 `stick`**：
 *   · 命中 `progWrite`（我们自己刚写下的位置）⇒ 跟随态原样保留；
 *   · 其余 ⇒ 以"此刻是否贴底"为准（上滚 = 停手；滚回底部 = 恢复跟随）。
 */
export function onStreamScroll(st: StreamFollowState, g: ScrollGeom): StreamFollowState {
    const ours = st.progWrite !== null && Math.abs(g.scrollTop - st.progWrite) < 1.5;
    if (ours) return { stick: st.stick, progWrite: null };
    return { stick: nearBottom(g), progWrite: null };
}

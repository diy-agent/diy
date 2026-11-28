// delivery.ts —— 「一条消息交给某个成员」的状态图（##43，2026-11-28）。
//
// **这是目标模型，尚未接线**。现在生效的是 `types.ts` 的 `DeliveryState`（3 个值
// `pending | working | done` + 一个 `note: 'failed'`），那是 2026-11-27 把 5 个状态压成
// 3 个时的权宜：`done` 于是同时表示「读完了」和「没送到就结束了」，两个字段互相打架。
// 用户 2026-11-28 的原话：「done 应该是发送成功了，而不是读完了吧，还有个 note，
// 这不是就是在解决状态不足的临时方案吗」—— 对，这就是。
//
// 目标：一张状态图说清全部，没有第二维。
//
//                       claim                    complete
//   ┌─────────┐ ──────────────▶ ┌─────────┐ ──────────────▶ ┌───────────┐
//   │ pending │                 │ working │                 │ delivered │  成功（终态）
//   └─────────┘ ◀────────────── └─────────┘                 └───────────┘
//        │        requeue             │
//        │ cancel                     │ cancel
//        ▼                            ▼
//   ┌───────────┐                ┌────────┐
//   │ cancelled │                │ failed │  真的没送到（终态）
//   └───────────┘                └────────┘
//
// 两条硬规矩（用户 2026-11-28 定）：
//   1. **用户「停止」= cancelled，不是 failed** —— 那是你自己干的，不该报警。
//   2. **steer 插不进正在跑的那轮 ≠ 失败** —— `working --requeue--> pending` 退回队列，
//      本轮结束后由 pump 正常取走；一条消息只尝试一次 steer，所以不会死循环。
//
// 为什么放 protocol 而不是 entity-runtime：转移规则是**前后端共用的契约**（UI 要按同一套
// 判「这条算成功还是取消」），而这个文件是纯函数、无 IO，符合本包的依赖规则。

/**
 * 一条投递此刻处于哪一步。
 *
 * `pending` 与 `working` 对**用户**是同一件事（都叫「发送中」），但在系统里必须分开：
 * 前者还没被谁取走，后者已经有一个成员在处理它 —— 「排队」与「在跑」的区别就在这。
 */
export type DeliveryPhase = 'pending' | 'working' | 'delivered' | 'failed' | 'cancelled';

/** 推动投递往前走的事件 */
export type DeliveryEvent =
    /** 某个成员取走了它（开始处理） */
    | 'claim'
    /** 处理完了，这一轮正常收尾 */
    | 'complete'
    /** 真的没送到（例如成员被删、房间被删、恢复时正文彻底丢失） */
    | 'fail'
    /** 用户主动「停止」，队列里的被一起清掉 */
    | 'cancel'
    /** 插话没插进正在跑的那轮 → 退回队列，等下一轮（不是失败） */
    | 'requeue';

/** 转移表：**唯一真源**。没列出来的组合 = 非法转移，`transition()` 会抛。 */
const TRANSITIONS: Readonly<Record<DeliveryPhase, Partial<Record<DeliveryEvent, DeliveryPhase>>>> = {
    pending: { claim: 'working', cancel: 'cancelled', fail: 'failed' },
    working: { complete: 'delivered', cancel: 'cancelled', fail: 'failed', requeue: 'pending' },
    // 终态：没有出路。要「再来一次」是**新的一条投递**（新的 messageId），不是把旧行复活
    delivered: {},
    failed: {},
    cancelled: {},
};

/** 能不能这么走（UI 与状态投影用它决定要不要显示某个动作） */
export function canTransition(from: DeliveryPhase, event: DeliveryEvent): boolean {
    return TRANSITIONS[from][event] !== undefined;
}

/**
 * 走一步。非法转移直接抛 —— 静默忽略等于让一个不该出现的事件把状态悄悄改掉，
 * 那正是这套状态图要消灭的东西。
 */
export function transition(from: DeliveryPhase, event: DeliveryEvent): DeliveryPhase {
    const next = TRANSITIONS[from][event];
    if (next === undefined) {
        throw new Error(`非法转移：${from} --${event}--> ?`);
    }
    return next;
}

/** 终态：不再变化（UI 可以把它当「结论」显示，不需要再轮询） */
export function isTerminal(phase: DeliveryPhase): boolean {
    return TRANSITIONS[phase].claim === undefined && Object.keys(TRANSITIONS[phase]).length === 0;
}

/**
 * 用户看到的四档 —— **只有这四个**（用户 2026-11-28 原话：「我作为设计者都不很理解」
 * delivered / lost / working 这些）。
 *
 * 内部五个状态 → 用户四档：`pending` 与 `working` 都是「发送中」。
 */
export type DeliveryPhaseView = 'sending' | 'succeeded' | 'failed' | 'cancelled';

const VIEW: Readonly<Record<DeliveryPhase, DeliveryPhaseView>> = {
    pending: 'sending',
    working: 'sending',
    delivered: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
};

export function deliveryViewOf(phase: DeliveryPhase): DeliveryPhaseView {
    return VIEW[phase];
}

/** 用户档的中文：UI 直接用，别各处再写一遍（写两遍就会有两套说法） */
export const DELIVERY_VIEW_TEXT: Readonly<Record<DeliveryPhaseView, string>> = {
    sending: '发送中',
    succeeded: '已送达',
    failed: '发送失败',
    cancelled: '已取消',
};

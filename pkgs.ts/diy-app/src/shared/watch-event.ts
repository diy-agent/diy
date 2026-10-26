// 🎯 JobWatch 的**中性事件契约**（##408 v2）：一条 watch 发生了变化，这件事本身长什么样。
//
// 为什么要有这一层：watch 的出口不止一个（房间事件 / 任务 journal / 人的信箱 /
// 直接 DM 某个 agent），而各家的数据形状不同（room 是 say 事件、journal 是一条 JSONL、
// inbox 是通知条目）。**先把事件说成中性的一小块**，再由各 sink 自己去翻译 ——
// 否则每加一个出口就得改 `job-watch.ts`，出口一多必然分叉（这家带 title、那家不带）。
//
// 三条纪律：
//   ① **零 IO、零时间**：`at` 由调用方给；本文件不 import node:*（renderer 也可能读）。
//   ② **正文已在 `job-watch.ts` 截断**（`WATCH_DIFF_MAX`），这里不再二次裁剪 ——
//      两个地方各裁一次，最后没人知道真实上限是多少。
//   ③ **`diff` 只放人话**：不带属性、不带 JSON。sink 需要的元数据在字段里。

/** 事件种类。`broken` 与 `changed` 分开：前者是「watch 自己坏了」，比「有变化」更该引人注意。 */
export type WatchEventKind = "changed" | "broken";

export interface WatchEvent {
    /** watch 的 id（sink 用来去重 / 聚合） */
    readonly watchId: string;
    /** 一行标题（watch 定义的 title） */
    readonly title: string;
    readonly kind: WatchEventKind;
    /** 事件发生时刻（ms epoch） */
    readonly at: number;
    /** 变化的那几行（`broken` 时是错误信息） */
    readonly diff: string;
    /** 观察对象的人话标识（`run:xxx` / `task:projects/4/tasks/408`）；无 = 省略 */
    readonly subject?: string;
}

/**
 * 渲染成人话（标题 + 正文两段，journal / inbox / room 都用它，别再各写一份）。
 *
 * 标题格式：`watch <id> · <title>`，后面跟变化摘要（`broken` 时明说「watch 坏了」）。
 * 正文 = diff 原文（已经过 `WATCH_DIFF_MAX` 截断）。
 */
export function watchEventText(ev: WatchEvent): { title: string; body: string } {
    const head = ev.kind === "broken" ? `watch ${ev.watchId} 坏了` : `watch ${ev.watchId} 有变化`;
    const subject = ev.subject ? `（${ev.subject}）` : "";
    return {
        title: `${head}${subject} · ${ev.title}`,
        body: ev.diff,
    };
}

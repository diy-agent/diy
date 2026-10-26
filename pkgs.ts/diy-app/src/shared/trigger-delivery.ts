// src/shared/trigger-delivery.ts
// 🎯 「这条触发器该投给谁、用什么力度」的**纯判据**（##408 v2 · 2026-10-26 大王裁）。
//
// 为什么要单独一个文件：这段判断以前长在 `main/services/local-agent.ts` 的
// `setTriggerDelivery(...)` 回调里 —— 想断言「owner 缺失时降级到 global」就得把整个
// agent 拉起来。判据与副作用分开后，单测只碰这个函数。
//
// 本文件只放纯函数：不读文件、不取时间、不认识 Electron。

import type { Level } from "./trigger";

/** 没有归属任务的收件地址（全局事件：整机环境坏了 / 模型全挂了）。 */
export const GLOBAL_ADDRESS = "global";

export interface DeliveryPlan {
    /** 要**叫醒**的任务（开一轮 / 插话）：`N1` 才有，按出现顺序去重。 */
    readonly wake: readonly string[];
    /** 要**落信箱**的收件地址（可在事后回看）：`N2`，以及 sinks 里显式写了 `inbox` 的。 */
    readonly inbox: readonly string[];
    /** 要不要让界面自己重画（横幅 / 顶栏）—— 不叫醒任何人，只是别让信息卡在内存里。 */
    readonly ui: boolean;
}

/** 空的投递计划（`N3` 与「解析不出任何收件人」都返回它；复用同一份冻结对象，别 new）。 */
export const NO_DELIVERY: DeliveryPlan = Object.freeze({ wake: [], inbox: [], ui: false });

/**
 * 把「一条触发器 + 一次载荷」算成投递计划。
 *
 * 三条规则（都可测，且都有现场）：
 *
 * 1. **`N0` 按 `N1` 处理**。`N0` 是空位（见 `shared/trigger.ts` 的 `Level` 注释）：
 *    这个系统里没有「系统推送抢焦点」的正当需求，所以谁写了 `N0` 就得到 `N1` 的效果 ——
 *    不报错、不红（大王 2026-10-26：先观察一阵，看有没有人真的想要更强的）。
 *
 * 2. **`owner` 解析不出 ⇒ 降级 `global`**（大王 2026-10-26 同意）。现场是
 *    `env:broken` / `notice:model-down` 这类**整机**事件：它们跟任何一条任务都没关系，
 *    `payload.owner` 永远是 undefined。以前这类只能投 `ui`（人不在窗口前就完全错过），
 *    现在它照样进得了信箱 —— 收件地址记 `global`，不假装属于某个任务。
 *    **且不再叫醒**：`global` 不是一条真任务，叫醒它会开出一条不存在的会话；全局事件
 *    本来就是「人要知道」而不是「agent 要立刻动手」（agent 下次自己会发现环境不对）。
 *
 * 3. **一次只算一个 sink**（`sink` 参数）。`dispatch()` 是逐 sink 回调的，若这里总按整条
 *    `def.sinks` 展开，`["owner","inbox"]` 就会投两遍。传了 `sink` 就只算它；省略 = 全部
 *    （单测与「这条到底会投给谁」的预览用）。
 *
 * 4. **`N1` 不自动补信箱**。`level#inbox` 说「N1 / N2 一律落信箱」，但按它自动展开会让
 *    每条后台进程结束都在信箱留一行（`INBOX_MAX` 200，一天就顶满）。所以这里**只认
 *    sinks 里显式写的 `inbox`** —— 等真出现「这条我事后想回看」的现场再加，
 *    不给「规矩上应该」先加一层噪声。
 */
export function planDelivery(
    def: { readonly level: Level; readonly sinks: readonly string[] },
    payload: { readonly owner?: unknown },
    onlySink?: string,
): DeliveryPlan {
    const level = def.level === "N0" ? "N1" : def.level;
    // N3 = 只进 journal：连 UI 都不该动（`dispatch` 已计数，这里就是终点）。
    if (level === "N3") return NO_DELIVERY;

    const owner = typeof payload.owner === "string" && payload.owner.trim() ? payload.owner : null;
    const wake: string[] = [];
    const inbox: string[] = [];
    let ui = false;

    const sinks = onlySink === undefined ? def.sinks : def.sinks.filter((s) => s === onlySink);
    for (const sink of sinks) {
        if (sink === "ui") {
            ui = true;
            continue;
        }
        // `def` = 触发器自带地址（watch 定义里的 sinks），watch 接线时才解析（##408 v2 待办 1）。
        if (sink === "def") continue;

        // 收件人：`owner` 变量解析不出就降级 global；`inbox` 是「投信箱」但不是地址，
        // 同样落到 owner / global 上（`job:session-aborted` 就是 `["owner","inbox"]`：
        // 同一个任务，一路叫醒、一路留痕）。
        const addr = sink === "owner" || sink === "inbox" ? (owner ?? GLOBAL_ADDRESS) : sink.startsWith("task:") ? sink.slice(5) : null;
        if (!addr) continue;

        if (addr === GLOBAL_ADDRESS) {
            // 全局事件没人可叫醒（`wakeTaskWithSteer("global")` 会开出一条不存在的任务）：
            // 力度自动降一级，只落信箱 —— 这仍是「降级」，不是【丢掉】。
            if (!inbox.includes(addr)) inbox.push(addr);
        } else if (sink === "inbox" || level === "N2") {
            if (!inbox.includes(addr)) inbox.push(addr);
        } else if (!wake.includes(addr)) {
            wake.push(addr);
        }
    }

    if (wake.length === 0 && inbox.length === 0 && !ui) return NO_DELIVERY;
    return { wake, inbox, ui };
}

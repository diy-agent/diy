/**
 * session-mark — 会话标记（nav 标签 / 任务表行 / 详情任务树）的**唯一合成判据**（##358）。
 *
 * 判据**两层**（缺一层都会得出假结论）：
 *   ① **注册表**（`sessionStore.chipOf`，进程内事实）：在跑 / 未读 / 留言 / 异常收尾 —— 有事才出 chip；
 *   ② **账本**（`usageLedgerStore`，落盘历史）：本进程没活动过，但账本有记录 ⇒ 「**已对话**」。
 *
 * 为什么必须有第 ② 层（用户 2026-10-17 要的）：
 *   注册表是**进程性**的，重启即空 —— 只认它的话，一开 app 所有会话都显示成"从没聊过"，
 *   正是本任务的起点痛点（"app 启动后丢了所有进度"）。**聊过的要一直看得见**，
 *   哪怕此刻没新消息、没在跑；和"从未开始"的任务在视觉上分开。
 *
 * 判据为什么不用「最后消息时间是否为空」：时间戳的缺失是**渲染侧的省略**（没数据就不写），
 * 不是事实 —— 拿它当"聊没聊过"的证据会撒谎。真正的依据是**账本文件有没有内容**。
 *
 * 为什么单列一层而不塞进 sessionStore：sessionStore 只认注册表（进程性），本函数是**跨源合成**
 * （注册表 + 账本 + 任务状态）。把两个 store 和树查询拉进任一 store 都成了循环依赖的温床。
 */
import { sessionStore } from "../store/sessionStore";
import { taskStore } from "../store/taskStore";
import { usageLedgerStore } from "../store/usageLedgerStore";
import type { SessionChipView } from "../../shared/session-overview";
import { findNode } from "./task-lineage";

/** 已完成的任务不再挂「已对话」标记（用户明确：**任务没 done 才显示**） */
const SILENT_STATES = new Set(["done", "cancelled"]);

/**
 * 这个任务**聊过没有**：本进程活动过（注册表有条目）**或**账本有内容。
 * 两者是"或"：注册表覆盖"刚起的会话还没记账"，账本覆盖"重启后注册表空了"。
 */
export function sessionStartedOf(uri: string): boolean {
    if (sessionStore.byUri(uri)) return true;
    return usageLedgerStore.startedOf(uri) === true;
}

/**
 * 会话标记：注册表有话要说 → 用它的 chip；否则**已对话** → 弱色 `◌ 已对话`；再否则 `null`（不渲染）。
 * `null` = 没什么可说的（从未聊过 / 已 done / 账本还没读到）。
 */
export function sessionMarkOf(uri: string): SessionChipView | null {
    const chip = sessionStore.chipOf(uri);
    if (chip) return chip;
    if (!sessionStartedOf(uri)) return null;
    // 任务已完成 → 不再提示（用户："如果任务没有 done，都显示角标"）
    const node = findNode(taskStore.nodes, uri);
    if (node?.state && SILENT_STATES.has(node.state)) return null;

    // 注册表没话可说 —— 但**账本**知道得更多：它是落盘的历史（跨启动）。
    // 用户 2026-10-17：「重启后要知道谁是未完成任务但已开启对话」「turnCount 也需存储」。
    //   · 跨启动总轮次 − 已读水位 = **未读条数**（判据在 sessionStore.unreadTurnsOf，一行口径）；
    //   · 为 0 ⇒ 只是"聊过"，给弱色 `◌ 已对话`。
    const unread = sessionStore.unreadTurnsOf(uri);
    if (unread > 0) {
        const total = sessionStore.turnsOf(uri) ?? 0;
        return {
            tone: "primary",
            icon: "",
            text: `+${unread}`,
            tip:
                `${uri}：**未读 ${unread} 条**（跨启动口径——本进程没活动过，` +
                `但会话一共跑了 ${total} 轮，你上次读到第 ${total - unread} 轮）。\n任务改到 done / cancelled 后此标记消失。`,
        };
    }
    return {
        tone: "ghost",
        icon: "◌",
        text: "已对话",
        tip: `${uri}：会话**已对话**（账本里有历史），此刻没有新消息、也没在跑。\n任务改到 done / cancelled 后此标记消失。`,
    };
}

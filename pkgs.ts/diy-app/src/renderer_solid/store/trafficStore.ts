import { createSignal } from "solid-js";

/**
 * 流量抽屉的**页面级开关**（单例）。
 *
 * 为什么用 store 而不是把 open 状态塞进 LocalChatPage：出错提示块（`ErrorBox`）与聊天工具栏
 * 都会发起「打开流量抽屉」，而提示块散布在多个渲染分支里（尾巴/过程行/轮头）。若把 onOpen
 * 一路透传，等于给整棵消息树加一条与内容无关的 prop 链。用全局 store 让「谁想开谁开」。
 */
/**
 * 打开时要定位的记录。
 *
 * `text` / `date` 是**筛选提示**：流量列表默认只查当天、且带上次的关键词，靠 traceId 硬找
 * 会"找不到就退化到最近一次失败"。带上它们，列表会先把筛选条件设成这两个值再查，
 * 于是目标那条**一定**在结果里（`##310` 的「在流量页打开」用）。
 */
export interface TrafficFocus {
    traceId?: string | null;
    reqId?: number | null;
    /** 全文关键词（如 turnId）：流量页会先把它填进搜索框再查 */
    text?: string;
    /** 日期 YYYY-MM-DD / all */
    date?: string;
}

const [open, setOpen] = createSignal(false);
const [focus, setFocus] = createSignal<TrafficFocus | null>(null);

export const trafficStore = {
    get open() {
        return open();
    },
    /** 打开时要定位的记录（按 id 优先，其次 trace_id；都没有则定位最近一次失败） */
    get focus() {
        return focus();
    },
    /** 打开抽屉；传 `focus` 则在列表里定位到那条记录 */
    openWith(f?: TrafficFocus) {
        setFocus(f ?? null);
        setOpen(true);
    },
    /**
     * **只置焦点，不开抽屉**：跨页跳转（`##310` 的「在流量页打开」）用。
     * 抽屉只挂在对话页，跨页跳的目标是导航栏「流量」页 —— 那边自己读 `focus`；
     * 这里若顺手 `setOpen(true)`，回到对话页会突然弹出一个抽屉（用户没点过）。
     */
    focusWith(f?: TrafficFocus) {
        setFocus(f ?? null);
    },
    close() {
        setOpen(false);
        setFocus(null);
    },
    /** 列表消费掉 focus 后清空，避免记录被挤掉后再重开会误定位 */
    clearFocus() {
        setFocus(null);
    },
};

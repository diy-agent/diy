import { createSignal } from "solid-js";

/**
 * 流量抽屉的**页面级开关**（单例）。
 *
 * 为什么用 store 而不是把 open 状态塞进 LocalChatPage：出错提示块（`ErrorBox`）与聊天工具栏
 * 都会发起「打开流量抽屉」，而提示块散布在多个渲染分支里（尾巴/过程行/轮头）。若把 onOpen
 * 一路透传，等于给整棵消息树加一条与内容无关的 prop 链。用全局 store 让「谁想开谁开」。
 */
const [open, setOpen] = createSignal(false);
const [focus, setFocus] = createSignal<{ traceId?: string | null; reqId?: number | null } | null>(null);

export const trafficStore = {
    get open() {
        return open();
    },
    /** 打开时要定位的记录（按 id 优先，其次 trace_id；都没有则定位最近一次失败） */
    get focus() {
        return focus();
    },
    /** 打开抽屉；传 `focus` 则在列表里定位到那条记录 */
    openWith(f?: { traceId?: string | null; reqId?: number | null }) {
        setFocus(f ?? null);
        setOpen(true);
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

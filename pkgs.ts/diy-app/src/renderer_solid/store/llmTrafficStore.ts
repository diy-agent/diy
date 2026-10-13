import { createSignal } from "solid-js";

/**
 * LLM 流量抽屉的**页面级开关**（单例）。
 *
 * 为什么用 store 而不是把 open 状态塞进 LocalChatPage：错误块（`ErrorBox`）与聊天工具栏
 * 都可能发起「打开流量面板」，而错误块散布在多个渲染分支里（尾巴/过程行/轮头）。若把
 * onOpen 一路透传，等于给整棵消息树加一条与内容无关的 prop 链。用全局 store 让
 * 「谁想开谁开」，错误块只 `openWith(traceId)` 一下即可。
 */
const [open, setOpen] = createSignal(false);
const [focusTraceId, setFocusTraceId] = createSignal<string | null>(null);

export const llmTrafficStore = {
    get open() {
        return open();
    },
    get focusTraceId() {
        return focusTraceId();
    },
    /** 打开抽屉；`traceId` 给定则在面板里定位到那条记录（错误块深链用） */
    openWith(traceId?: string | null) {
        setFocusTraceId(traceId ?? null);
        setOpen(true);
    },
    close() {
        setOpen(false);
        setFocusTraceId(null);
    },
    /** 面板消费掉 focus 后清空，避免环形里该条被挤掉后再重开会误定位 */
    clearFocus() {
        setFocusTraceId(null);
    },
};

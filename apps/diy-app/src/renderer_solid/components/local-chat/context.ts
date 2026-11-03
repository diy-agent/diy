/**
 * LocalChatContext — 页面级状态的**只读分发**（##448 刀 2，用户 2026-10-28 裁）。
 *
 * 为什么需要：页面体 1400+ 行、几十个 signal / 回调。全部走 props 会造几十个转发参数，
 * 比一层 context 更糟。故只放这一个口子：
 *   · **只装** store 引用与既有 signal / 回调（都是 `useLocalChatPage` 的返回值，同名同源）
 *   · **不装**新业务状态、不复制 store 内部状态（判据：`store/localChatStore.ts` 零 diff）
 */
import { createContext, useContext } from "solid-js";
import type { LocalChatApi } from "./state";

export const LocalChatCtx = createContext<LocalChatApi>();

/** 取页面 API；脱离 Provider 使用 = 拆错了（子组件只该由 `index.tsx` 渲染） */
export function useLocalChat(): LocalChatApi {
    const v = useContext(LocalChatCtx);
    // error-code-ok: 纯防御性 throw —— 脱离 Provider 使用 = 拆错了，没有可判别的业务码
    if (!v) throw new Error("ui/local-chat-context-missing: 子组件必须在 LocalChatPage 内渲染");
    return v;
}

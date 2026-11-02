// title.ts — 窗口标题（主进程与 renderer 共用；单独成文件避免把 profile 拖进 renderer bundle）

export const TITLE = "diy 聊天（多会话）";

/** 内存入口（##505-E / 原 ##504）：没有历史、重启即丢 —— 标题里必须写出来，别让人拿它当真用 */
export const MEMORY_TITLE = "diy 聊天 · 内存模式（重启后丢失）";

/** 按模式取标题：渲染层从 `window.__DIY_CHAT_MODE__` 拿（memory 入口的 html 里注入） */
export function titleForMode(mode: string | undefined): string {
    return mode === "memory" ? MEMORY_TITLE : TITLE;
}

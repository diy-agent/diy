// index.ts — 公开入口：契约类型 + 主进程侧页面工厂 + 固定回复常量。
// renderer 侧另走 `@diy/chat-page/renderer`（不在这里 re-export，避免把 DOM 代码带进主进程）。
export { FAKE_REPLY, createFakeLlm, createPage, default } from "./main.js";
export { ChatPageError } from "./errors.js";
export type { SendResult, WireMessage } from "./shared.js";

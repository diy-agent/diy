// index.ts — 公开入口：契约类型 + 主进程侧页面工厂 + 固定回复常量。
// renderer 侧另走 `@diy-agent/chat-page/renderer`（不在这里 re-export，避免把 DOM 代码带进主进程）。
export { FAKE_REPLY, createFakeLlm, createPage, default, wireOf } from "./main.js";
export { toBlocks } from "./blocks.js";
export { BUILTIN_BLOCK_KINDS, textMessage } from "./shared.js";
export { ChatPageError } from "./errors.js";
export type { AgentEvent } from "./blocks.js";
export type {
    Block,
    BotChatHost,
    BotChatSnapshot,
    BotDraftInput,
    BotUpdateInput,
    BotView,
    ChatMetrics,
    FirstBotInput,
    ModelChoice,
    SendArgs,
    SendResult,
    TextBlockData,
    ThinkBlockData,
    ToolBlockData,
    WireMessage,
} from "./shared.js";

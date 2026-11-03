// blocks.ts — core 事件 → Block 的归一化（**主进程侧**，##499）。
//
// ##505：实现搬到 `@diy-agent/bot/protocol`（bot 对话宿主产出消息线时也要用同一份映射；
// 真源只有一处）。本文件保留为 re-export，既有 `@diy-agent/chat-page` 的导出面不变。

export { eventsOfMessage, toBlocks, wireOf } from "@diy-agent/bot/protocol";
export type { AgentEvent } from "@diy-agent/bot/protocol";

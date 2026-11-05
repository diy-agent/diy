// @diy-agent/bot — bot 实体：身份（BotConfig）+ 会话归属（方案 B）
//
// ##480 方向：bot 默认活在内存里（`createBot({ config })` 不传 store 即可）；
// 要不要落盘由**装配器**决定 —— 装配器实例化 store 后传进来：
//
//   import { createFileBotStore, ensureBot } from '@diy-agent/bot';
//
//   const store = createFileBotStore({ home: '/Users/me/.diy' });
//   const config = await ensureBot(store, { id: 'bot-1', name: '大王助手', instructions: '…' });
//   const bot = createBot({ store, config });
//
//   const id = await bot.newSession();       // 会话目录里写 bot.json { botId }
//   await bot.sessions();                     // 只列归这个 bot 的会话
//
// 边界（##469 判据 4）：源码里不出现「协作空间」内核的字样；
// 不依赖会话内核 / 桌面壳 / 任务包；记忆接口先留空。
//
// ##470：人物（persona）的 schema / 类型 / 内置缺省值也住在本包（`./persona` 子路径，
// 纯 zod 无 node:*，renderer 可引；主入口带文件存储，renderer 不要引）。

export { BotError } from "./errors.js";
export type { BotErrorCode } from "./errors.js";

// ── 包内私有（2026-11-05 A1）──
// 这些是**实现细节**，不是包能力：
//   createBot / ensureBot / openBot   —— 建/开 bot 句柄（只有 chat.ts 和测试用）
//   createFirstBot / hasAnyBot        —— 首启建 bot（同样只有 chat.ts 用）
//   newSessionId / setBotModel        —— 内部工具
// 对外唯一的入口是 `createBotChat`（对话宿主 = 本包的组合根）+
// `createFileBotStore` / `createMemoryBotStore`（装配器要传的存储）。
// 判据：「一个包对外导出的每个符号都要能回答『谁会用它』」——
// 上面的答案都是「装配需要」，不是「使用需要」。


// ##505：bot 对话宿主（send / snapshot / 模型解析 / 会话标题 / actor 队列）。
// 会话只是内部技术：没有会话列表，一个 bot 一条长期会话。
export {
    DEFAULT_MAX_TOOL_STEPS,
    FIRST_BOT_DRAFT,
    createBotChat,
    createSerial,
    splitModelKey,
    workspaceOf,
} from "./chat.js";
export type { BotChatOptions, Serial } from "./chat.js";

// ##517：上下文压缩（阈值 → 摘要 → notice；判据/摘要 prompt 全用 @diy-agent/compaction）
export { SUMMARY_INPUT_MAX_CHARS, applyPriorBoundary, createBotCompactor } from "./compaction.js";
export type { BotCompactionEvent, BotCompactionState, BotCompactor, BotCompactorOptions } from "./compaction.js";

// ##516：系统上下文（AGENTS.md 链 + facts 摘要）—— 简化版组装器，只在建会话时跑一次。
// 导出是为了让装配器 / 测试能单独验（bot 没装上下文时也能调）。
export { SYSTEM_CONTEXT_MAX_BYTES, agentsChainOf, buildSystemContext, factsSummaryOf } from "./system-context.js";
export type { AgentsFileRef, SystemContextOptions, SystemContextResult } from "./system-context.js";

// ##514 第 3 步：工具**执行**（定义在 @diy-agent/tools，bot 只按名字执行 + 把结果交回 Session）
export { TOOL_RESULT_MAX_CHARS, asToolSet, runToolCalls } from "./tools.js";
export type { BotTool, BotToolOptions, BotToolSet, PendingToolCall } from "./tools.js";

// 线上形状（纯数据 + 纯映射）也可从子路径 `@diy-agent/bot/protocol` 单独取
// —— renderer 用那个，不会把 node:* 带进浏览器包。
export * from "./protocol.js";

export { createFileBotStore } from "./store-fs.js";
export type { FileBotStoreOptions } from "./store-fs.js";

// 缺省存储：内存实现住在本包（`createBot({ config })` 不传 store 时用的就是它）
export { createMemoryBotStore } from "./store-memory.js";

export type { Bot, BotConfig, BotDraft, BotId, BotSessionRef, BotStore, CreateBotOptions } from "./types.js";

// ##497：bot 的全局标识（稳定标识 / 显示地址）。纯函数，renderer 也能引。
export { BOT_ID_PATTERN, NODE_ID_PATTERN, botUri, isStableBotUri, nextBotId, parseBotUri } from "./uri.js";
export type { BotUriDisplayRef, BotUriParts, BotUriRef, ParsedBotUri } from "./uri.js";

// 人物 schema / 类型 / 内置缺省（##470：bot = 人设）。
// 也可从子路径 `@diy-agent/bot/persona` 单独取（纯 zod，renderer 用那个）。
export * from "./persona.js";

// ##A3：bot 管理域（业务规则：重名 / id 生成 / 模型必填）。
// 从 bot-config-page 的 actions.ts 搬来 —— 那些规则换个宿主（Web/CLI）还要用同一份。
export { createBotAdmin } from "./admin.js";
export type { BotAdmin, BotAdminOptions, BotAdminRow, BotAdminDraft } from "./admin.js";

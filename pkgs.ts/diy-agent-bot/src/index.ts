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

export { createBot, ensureBot, newSessionId, openBot } from "./bot.js";

export { createFileBotStore } from "./store-fs.js";
export type { FileBotStoreOptions } from "./store-fs.js";

// 缺省存储：内存实现住在本包（`createBot({ config })` 不传 store 时用的就是它）
export { createMemoryBotStore } from "./store-memory.js";

export type { Bot, BotConfig, BotDraft, BotId, BotSessionRef, BotStore, CreateBotOptions } from "./types.js";

// 人物 schema / 类型 / 内置缺省（##470：bot = 人设）。
// 也可从子路径 `@diy-agent/bot/persona` 单独取（纯 zod，renderer 用那个）。
export * from "./persona.js";

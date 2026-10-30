// @diy-agent/bot — bot 实体：身份（BotConfig）+ 会话归属（方案 B）
//
//   import { createFileBotStore, ensureBot } from '@diy-agent/bot';
//
//   const store = createFileBotStore({ home: '/Users/me/.diy' });
//   const config = await ensureBot(store, { id: 'bot-1', name: '大王助手', persona: '…' });
//   const bot = createBot({ store, config });
//
//   const id = await bot.newSession();       // 会话目录里写 bot.json { botId }
//   await bot.sessions();                     // 只列归这个 bot 的会话
//
// 边界（##469 判据 4）：源码里不出现「协作空间」内核的字样；
// 不依赖会话内核 / 桌面壳 / 任务包；记忆接口先留空。

export { BotError } from "./errors.js";
export type { BotErrorCode } from "./errors.js";

export { createBot, ensureBot, newSessionId, openBot } from "./bot.js";

export { createFileBotStore } from "./store-fs.js";
export type { FileBotStoreOptions } from "./store-fs.js";

export type { Bot, BotConfig, BotDraft, BotId, BotSessionRef, BotStore, CreateBotOptions } from "./types.js";

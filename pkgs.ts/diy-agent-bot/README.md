# @diy-agent/bot

diy 的 bot 实体：身份配置 + 会话归属。

```ts
import { createFileBotStore, ensureBot, createBot } from "@diy-agent/bot";

const store = createFileBotStore({ home: "/Users/me/.diy" });
const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "…" });
const bot = createBot({ store, config });

const id = await bot.newSession(); // 会话目录里写 bot.json { botId }
await bot.sessions();             // 只列归这个 bot 的会话
```

- 身份：`<home>/bots/<id>/bot.json`
- 归属：`<sessionsDir>/<sessionId>/bot.json`（方案 B）
- 人设：bot = 人设（##470）—— `BotConfig` = `PersonaDef`（`./persona` 子路径，纯 zod 无 node:*）+ id + 时间；
  旧 `bot.json` 里的 `persona` 字段读兼容映射到 `instructions`
- 边界：不认识 room / task / session 内核；删 bot 不删会话

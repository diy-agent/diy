// 契约测试（##506）：BotStore 的文件实现与内存实现跑**同一批用例**（用例在 @diy-agent/store-contract/bot）。
// 本实现特有的行为（bot.json 落盘形状 / persona 旧字段读兼容 / needsModel 不落盘 / 坏 JSON 读成 null）
// 在 tests/bot.test.ts 里，不进契约。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineBotStoreContract } from '@diy-agent/store-contract/bot';
import { createFileBotStore, createMemoryBotStore } from '../src/index.js';

defineBotStoreContract('fs', async () =>
    createFileBotStore({ home: await mkdtemp(join(tmpdir(), 'diy-bot-contract-fs-')) }),
);
defineBotStoreContract('memory', () => createMemoryBotStore());

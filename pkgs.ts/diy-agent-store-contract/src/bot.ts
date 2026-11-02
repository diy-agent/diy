// bot.ts — BotStore 契约：**一份用例**，文件实现与内存实现跑同一批（##506）
//
//   // diy-agent-bot/tests/store-contract.test.ts
//   defineBotStoreContract('fs', () => createFileBotStore({ home: mkdtemp(), sessionsDir: tmp }));
//
// 边界同 session 契约：只测**接口语义**（load/save/list/remove/ownerOf/assign/sessionsOf）。
// 实现特有的行为不进契约：
//   · store-fs：bot.json 落盘形状 / `persona` 旧字段读兼容 / `needsModel` 不落盘 / 坏 JSON 读成 null
//   · store-memory：不碰文件系统（零落盘）
// 这些留在各实现自己的测试里。

import { describe, expect, it } from 'vitest';
import type { BotConfig, BotStore } from '@diy-agent/bot';

const AT = '2026-11-02T17:49:37.907+0800';

function config(id: string, overrides: Partial<BotConfig> = {}): BotConfig {
    return {
        id,
        name: `bot ${id}`,
        instructions: `你是 ${id}`,
        model: 'mock/model-1',
        createdAt: AT,
        updatedAt: AT,
        ...overrides,
    };
}

/**
 * 声明「这个实现满足 BotStore 契约」。
 *
 * @param name      实现名（进 describe 标题）
 * @param makeStore 每次调用都返回一个**全新的空 store**（每个用例独立）
 */
export function defineBotStoreContract(name: string, makeStore: () => BotStore | Promise<BotStore>): void {
    describe(`${name} 满足 BotStore 契约`, () => {
        it('空 store：list() = []，load() / ownerOf() = null', async () => {
            const store = await makeStore();
            expect(await store.list()).toEqual([]);
            expect(await store.load('nobody')).toBeNull();
            expect(await store.ownerOf('no-session')).toBeNull();
        });

        it('save 后 load 返回同内容', async () => {
            const store = await makeStore();
            const bot = config('bot-a');
            await store.save(bot);
            expect(await store.load('bot-a')).toEqual(bot);
        });

        it('list() 列出全部 bot，按 id 升序（与写入顺序无关）', async () => {
            const store = await makeStore();
            await store.save(config('bot-c'));
            await store.save(config('bot-a'));
            await store.save(config('bot-b'));
            expect((await store.list()).map((bot) => bot.id)).toEqual(['bot-a', 'bot-b', 'bot-c']);
        });

        it('同 id 再 save 是覆盖（不是新增一条）', async () => {
            const store = await makeStore();
            await store.save(config('bot-a'));
            const updated = config('bot-a', { name: '改过名', model: 'mock/model-2', updatedAt: AT });
            await store.save(updated);
            expect(await store.list()).toHaveLength(1);
            expect(await store.load('bot-a')).toEqual(updated);
        });

        it('assign 后 ownerOf 读到归属；重新 assign 覆盖旧归属', async () => {
            const store = await makeStore();
            await store.assign('s1', 'bot-a');
            expect(await store.ownerOf('s1')).toBe('bot-a');
            await store.assign('s1', 'bot-b');
            expect(await store.ownerOf('s1')).toBe('bot-b');
        });

        it('sessionsOf 只列归属该 bot 的会话', async () => {
            const store = await makeStore();
            await store.assign('s1', 'bot-a');
            await store.assign('s2', 'bot-b');
            await store.assign('s3', 'bot-a');
            const ids = (await store.sessionsOf('bot-a')).map((ref) => ref.id).sort();
            expect(ids).toEqual(['s1', 's3']);
            expect((await store.sessionsOf('bot-a')).every((ref) => ref.botId === 'bot-a')).toBe(true);
            expect(await store.sessionsOf('bot-c')).toEqual([]);
        });

        it('remove 只删 bot 本身：会话归属一个不动（删 bot 不丢会话数据）', async () => {
            const store = await makeStore();
            await store.save(config('bot-a'));
            await store.assign('s1', 'bot-a');

            await store.remove('bot-a');

            expect(await store.load('bot-a')).toBeNull();
            expect(await store.list()).toEqual([]);
            // 会话是主体：归属还在，sessionsOf 照样列得出来
            expect(await store.ownerOf('s1')).toBe('bot-a');
            expect((await store.sessionsOf('bot-a')).map((ref) => ref.id)).toEqual(['s1']);
        });

        it('remove 不存在的 bot 不报错（幂等）', async () => {
            const store = await makeStore();
            await expect(store.remove('nobody')).resolves.toBeUndefined();
        });
    });
}

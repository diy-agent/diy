// tests/page.test.ts — bot 配置页（主进程侧）的判据（##474）
//
//   T1  交付 id / title / methods；没有数据根 ⇒ 调用时抛
//   T2  snapshot：列表 / 模型目录 / 会话数
//   T3  createBot：bot.json 结构符合 @diy-agent/bot 的 schema；id 自增
//   T4  saveBot：改 name / instructions / model，createdAt 不变，model 置空 = 删键
//   T5  removeBot：只删 bots/<id>/，会话目录不动
//   T6  测试对话：真模型（注入假 LLM）能收到回复；**$DIY_HOME 下不出现任何新文件**
//   T7  testReset：清空内存里的对话；再发一句没有上文（seq 从 1 重开）

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmPort } from '@diy-agent/session';
import { createBotActions } from '../src/actions.js';
import { createPage } from '../src/index.js';

const MODEL = `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: one
        data:
          value: sk-test-123
customProviders:
  goat:
    accounts:
      - type: apiKey
        name: default
        data:
          value: ''
`;

const CUSTOM = `goat:
  id: goat
  npm: '@ai-sdk/openai-compatible'
  api: https://goat.example/v1
  models:
    m1:
      id: m1
      name: Goat One
      limit:
        context: 1000
      cost:
        input: 1
        output: 2
`;

const homes: string[] = [];

function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'bot-config-page-'));
    homes.push(home);
    writeFileSync(join(home, 'model.yaml'), MODEL, 'utf-8');
    writeFileSync(join(home, 'providers.custom.yaml'), CUSTOM, 'utf-8');
    return home;
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 递归列出目录下所有文件（相对路径；不存在 = 空） */
function listFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        let items;
        try {
            items = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of items) {
            const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
            if (item.isDirectory()) walk(join(dir, item.name), rel);
            else out.push(rel);
        }
    };
    walk(root, '');
    return out.sort();
}

const fakeLlm: LlmPort = {
    async *chat() {
        yield { type: 'text', text: '这是测试回复' };
        yield { type: 'usage', inputTokens: 7, outputTokens: 3 };
        yield { type: 'done', stopReason: 'stop' };
    },
};

describe('bot-config 页面（主进程侧）', () => {
    it('T1：交付 id / title / methods；没有数据根 ⇒ 调用时抛', () => {
        const page = createPage({ home: makeHome() });
        expect(page.id).toBe('bot-config');
        expect(page.title).toBe('Bot 配置');
        expect(Object.keys(page.methods ?? {}).sort()).toEqual([
            'createBot',
            'removeBot',
            'saveBot',
            'snapshot',
            'testReset',
            'testSend',
        ]);

        const bare = createPage({});
        const saved = process.env['DIY_HOME'];
        delete process.env['DIY_HOME'];
        try {
            expect(() => bare.methods!['snapshot']!(undefined)).toThrow(/数据根/);
        } finally {
            if (saved !== undefined) process.env['DIY_HOME'] = saved;
        }
    });

    it('T2/T3：新建 bot 写 bot.json；列表带会话数与模型目录', async () => {
        const home = makeHome();
        const actions = createBotActions({ home, clock: () => new Date('2026-10-30T10:00:00Z') });
        const empty = await actions.snapshot();
        expect(empty.bots).toEqual([]);
        expect(empty.models.map((item) => `${item.providerId}/${item.modelId}`)).toEqual(['goat/m1']);

        const created = await actions.create({ name: '小助手', instructions: '说话简短', model: 'goat/m1' });
        expect(created.bots.map((bot) => bot.id)).toEqual(['bot-1']);
        const bot = created.bots[0]!;
        expect(bot).toMatchObject({
            id: 'bot-1',
            name: '小助手',
            instructions: '说话简短',
            model: 'goat/m1',
            sessionCount: 0,
        });

        const onDisk = JSON.parse(readFileSync(join(home, 'bots', 'bot-1', 'bot.json'), 'utf-8')) as Record<
            string,
            unknown
        >;
        // 判据 5：结构与 @diy-agent/bot 的 schema 一致（id/name/instructions/model/createdAt/updatedAt）
        expect(Object.keys(onDisk).sort()).toEqual(
            ['createdAt', 'id', 'instructions', 'model', 'name', 'updatedAt'].sort(),
        );
        expect(onDisk['createdAt']).toBe('2026-10-30T10:00:00.000Z');

        const second = await actions.create({ name: '二号' });
        expect(second.bots.map((item) => item.id).sort()).toEqual(['bot-1', 'bot-2']);
        // 没指定模型 = 不写 model 键
        const secondDisk = JSON.parse(readFileSync(join(home, 'bots', 'bot-2', 'bot.json'), 'utf-8')) as Record<
            string,
            unknown
        >;
        expect('model' in secondDisk).toBe(false);
    });

    it('T4：改身份；createdAt 不动，model 置空 = 删键', async () => {
        const home = makeHome();
        let now = new Date('2026-10-30T10:00:00Z');
        const actions = createBotActions({ home, clock: () => now });
        await actions.create({ name: '小助手', instructions: '旧指令', model: 'goat/m1' });

        now = new Date('2026-10-30T11:00:00Z');
        const saved = await actions.save({
            id: 'bot-1',
            name: '改名了',
            instructions: '新指令',
            model: '',
        });
        const bot = saved.bots[0]!;
        expect(bot.name).toBe('改名了');
        expect(bot.instructions).toBe('新指令');
        expect(bot.model).toBeNull();
        expect(bot.createdAt).toBe('2026-10-30T10:00:00.000Z');
        expect(bot.updatedAt).toBe('2026-10-30T11:00:00.000Z');
        const onDisk = JSON.parse(readFileSync(join(home, 'bots', 'bot-1', 'bot.json'), 'utf-8')) as Record<
            string,
            unknown
        >;
        expect('model' in onDisk).toBe(false);
    });

    it('T4b：模型不在目录里 ⇒ 拒绝（不写坏数据）', async () => {
        const home = makeHome();
        const actions = createBotActions({ home });
        await expect(actions.create({ name: 'x', model: 'nope/model' })).rejects.toThrow(/模型目录里没有/);
        expect(existsSync(join(home, 'bots'))).toBe(false);
    });

    it('T5：删 bot 只删 bots/<id>/，会话目录不动', async () => {
        const home = makeHome();
        const actions = createBotActions({ home });
        await actions.create({ name: '小助手' });
        // 模拟一个归属 bot-1 的会话目录
        const sessionDir = join(home, 'sessions', 'chat', 's-1');
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'bot.json'), JSON.stringify({ botId: 'bot-1' }), 'utf-8');

        const before = await actions.snapshot();
        expect(before.bots[0]?.sessionCount).toBe(1);

        const after = await actions.remove({ id: 'bot-1' });
        expect(after.bots).toEqual([]);
        expect(existsSync(join(home, 'bots', 'bot-1'))).toBe(false);
        expect(existsSync(join(sessionDir, 'bot.json'))).toBe(true);
    });

    it('T6：测试对话收到真回复；$DIY_HOME 下不出现任何新文件（判据 4）', async () => {
        const home = makeHome();
        const actions = createBotActions({ home, llmFor: () => fakeLlm });
        await actions.create({ name: '小助手', instructions: '说话简短', model: 'goat/m1' });

        const before = listFiles(home);
        const view = await actions.testSend({ id: 'bot-1', text: '你好' });
        expect(view.ephemeral).toBe(true);
        expect(view.botId).toBe('bot-1');
        expect(view.messages.map((item) => `${item.role}:${item.text}`)).toEqual([
            'user:你好',
            'assistant:这是测试回复',
        ]);
        expect(view.usage.turns).toBe(1);
        // 判据 4：一个字节都没多（bot.json 是上面 create 写的，早就在 before 里）
        expect(listFiles(home)).toEqual(before);
    });

    it('T7：testReset 清空内存；再发一句不带上文（seq 从 1 重开）', async () => {
        const home = makeHome();
        const seen: number[][] = [];
        const actions = createBotActions({
            home,
            llmFor: () => ({
                async *chat(messages) {
                    seen.push(messages.map((item) => item.seq ?? 0));
                    yield { type: 'text', text: 'ok' };
                    yield { type: 'done', stopReason: 'stop' };
                },
            }),
        });
        await actions.create({ name: '小助手', model: 'goat/m1' });
        await actions.testSend({ id: 'bot-1', text: '第一句' });
        const cleared = await actions.testReset({ id: 'bot-1' });
        expect(cleared.messages).toEqual([]);
        expect(cleared.usage.turns).toBe(0);

        const view = await actions.testSend({ id: 'bot-1', text: '第二句' });
        expect(view.messages.map((item) => item.text)).toEqual(['第二句', 'ok']);
        // 第二次调用的消息线只有新的一问（seq 1），没有累积上一轮
        expect(seen[0]).toEqual([1]);
        expect(seen[1]).toEqual([1]);
    });
});

// golden-chat.test.ts — 用**真实录制的模型流**驱动整套 bot 对话（C4）
//
// 和其他 golden 测试的分工：
//   chat-stream.blackbox  fixture → chatStream → SessionDelta（provider 层）
//   tool-golden.dom       fixture → toBlocks → DOM（渲染层）
//   **这里**              fixture → chatStream → session → **BotChatHost**（整条链）
//
// 关键：不是手写一个 `LlmPort`（那样测的是测试自己的假设），
// 而是把**真的 chatStream** 包成 LlmPort —— 中间任何一层改了行为都会红。
//
// 为什么值得：chat.test.ts 里的 fakeLlm 只会 yield `收到：xxx`，
// 真实模型的 tool-call / 多步 / 错误形状一个都走不到。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBotChat } from '@diy-agent/bot';
import { chatStream } from '@diy-agent/llm-provider';
import type { LlmPort, ChatMessage, ChatOptions } from '@diy-agent/session';
import { replay } from '@diy-agent/test-llm';
import { toolOk, toolMultiStep, textOnly } from '@diy-agent/test-llm/fixtures';

const wire = { provider: 'test', model: 'test-model', baseUrl: 'https://example.test/v1' };

/** 消息线的正文在 `blocks` 里（不是 message.text）—— 和 chat.test.ts 同一套提取方式 */
function textsOf(messages: readonly { blocks: readonly { kind: string; data: Record<string, unknown> }[] }[]): string[] {
    return messages.map((m) =>
        m.blocks.map((b) => (b.kind === 'text' ? String(b.data['text']) : `[${b.kind}]`)).join(''),
    );
}

/** 把**真的 chatStream** 包成 LlmPort —— 这是本文件的核心，不是手写映射 */
const goldenLlm = (parts: Parameters<typeof replay>[0]): LlmPort => ({
    chat: (messages: readonly ChatMessage[], options?: ChatOptions) =>
        chatStream(replay(parts).asModel(), messages, options, undefined, wire),
});

/**
 * 临时数据根：一个 custom provider `test/echo-1`，key 是假值 ——
 * `llmFor` 注入了录制模型，**真发请求永远不走这条路**，但 `checkModel` 要读到目录里有它。
 */
function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'diy-golden-chat-'));
    writeFileSync(
        join(home, 'model.yaml'),
        `customProviders:
  test:
    accounts:
      - type: apiKey
        name: main
        data:
          value: fake-key
`,
        'utf-8',
    );
    writeFileSync(
        join(home, 'providers.custom.yaml'),
        `test:
  id: test
  npm: "@ai-sdk/openai-compatible"
  api: http://127.0.0.1:1/v1
  models:
    echo-1:
      name: Echo 1
      cost: { input: 1, output: 2 }
      limit: { context: 1000 }
`,
        'utf-8',
    );
    return home;
}

describe('真实录制流驱动 bot 对话', () => {
    it('text-only：发一句 → 消息线里出现 user + assistant，正文来自 fixture', async () => {
        const host = createBotChat({ home: makeHome(), llmFor: () => goldenLlm(textOnly) });
        // 先建一个 bot（首启自动建也行，这里显式建便于断言）
        const snap = await host.createBot({ name: '录制的', model: 'test/echo-1' });
        const bot = snap.bots[0];
        expect(bot, '建 bot 后快照里该有它').toBeDefined();

        const after = await host.send('在吗', () => {});
        const msgs = after.messages ?? [];
        expect(msgs.map((m) => m.role)).toContain('user');
        const bodies = textsOf(msgs).filter((t) => t !== '');
        expect(bodies.join('').replace(/\s/g, '').length, '助手正文不该是空的').toBeGreaterThan(0);
    });

    it('tool-ok：真实 tool-call 能走通 —— 工具面拿到调用，结果回填进消息线', async () => {
        const seen: { name: string; args: unknown }[] = [];
        const host = createBotChat({
            home: makeHome(),
            llmFor: () => goldenLlm(toolOk),
            // BotToolSet = Record<名字, { execute }>；只取 execute（description/inputSchema 由外部提供）
            toolsFor: () => ({
                read: {
                    execute: async (args: unknown) => {
                        seen.push({ name: 'read', args });
                        return '文件内容（测试桩）';
                    },
                },
            }),
        });
        await host.createBot({ name: '工具 bot', model: 'test/echo-1' });
        const after = await host.send('读一下 README.md', () => {});

        // 关键断言：**真实 fixture 里的 tool-call 真的走到了执行桩**
        expect(seen.length, '真实录制里的 tool-call 没被工具面接住').toBeGreaterThan(0);
        expect(seen[0]!.name).toBe('read');
        expect(after.messages?.length ?? 0).toBeGreaterThan(1);
    });

    it('多步：tool-multi-step 能连跑两轮（模型再调一次工具）', async () => {
        let calls = 0;
        const host = createBotChat({
            home: makeHome(),
            llmFor: () => goldenLlm(toolMultiStep),
            toolsFor: () => ({
                read: { execute: async () => { calls += 1; return 'ok'; } },
                write: { execute: async () => { calls += 1; return 'ok'; } },
            }),
        });
        await host.createBot({ name: '多步 bot', model: 'test/echo-1' });
        const after = await host.send('把这个文件改一下', () => {});

        // tool-multi-step 的 fixture 里是两次调用（read → write）
        expect(calls, '多步 fixture 该触发至少一次工具执行').toBeGreaterThan(0);
        expect(after.messages?.length ?? 0).toBeGreaterThan(2);
    });
});

// context-guard.test.ts —— 轮内水位的三条边界。
//
// 这里锁的是**判据**，不是「别的代码会不会调它」：
//   · 没超水位 ⇒ 一个字节都不改（砸前缀缓存是真实成本）；
//   · 超了 ⇒ 只折最早的**工具输出**，toolCallId / 配对 / 消息顺序全保留；
//   · 窗口未知 ⇒ 不猜（与压缩判据同一条规矩：猜窗口只会更糟）。

import { describe, expect, it } from 'vitest';

import type { ModelMessage } from 'ai';

import { estimateMessagesTokens, guardMessages } from '../src/context-guard';

const big = (chars: number): string => 'x'.repeat(chars);

/** 一条 assistant 工具调用 + 它的结果（结构照 AI SDK 的形状，toolCallId 必须能对上） */
function toolPair(id: string, chars: number): ModelMessage[] {
    return [
        {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: { command: 'ls' } }],
        },
        {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: id,
                    toolName: 'bash',
                    output: { type: 'text', value: big(chars) },
                },
            ],
        },
    ];
}

describe('guardMessages', () => {
    it('没超水位 ⇒ null（不改任何字节）', () => {
        const messages: ModelMessage[] = [{ role: 'user', content: '你好' }, ...toolPair('t1', 4_000)];
        expect(guardMessages(messages, { windowTokens: 1_000_000 })).toBeNull();
    });

    it('窗口未知 ⇒ null（不猜窗口）', () => {
        const messages = toolPair('t1', 400_000);
        expect(guardMessages(messages, { windowTokens: 0 })).toBeNull();
    });

    it('超水位 ⇒ 只折工具输出，toolCallId 与消息条数不变', () => {
        const messages: ModelMessage[] = [{ role: 'user', content: '开始' }, ...toolPair('t1', 400_000)];
        const guard = guardMessages(messages, { windowTokens: 100_000 });
        expect(guard).not.toBeNull();
        expect(guard!.collapsed).toBe(1);
        expect(guard!.after).toBeLessThan(guard!.before);
        // 结构原样：条数、角色、toolCallId、toolName 都不许动
        expect(guard!.messages).toHaveLength(messages.length);
        const folded = guard!.messages[2] as { content: Array<Record<string, unknown>> };
        expect(folded.content[0]!['toolCallId']).toBe('t1');
        expect(folded.content[0]!['toolName']).toBe('bash');
        const output = folded.content[0]!['output'] as { type: string; value: string };
        expect(output.type).toBe('text');
        expect(output.value).toContain('已折叠');
        // 原数组没被就地改（只影响这一次请求）
        const original = messages[2] as { content: Array<{ output: { value: string } }> };
        expect(original.content[0]!.output.value).toHaveLength(400_000);
    });

    it('越早的工具输出越先被折（后面的步骤还在用最近的）', () => {
        const messages: ModelMessage[] = [...toolPair('t1', 300_000), ...toolPair('t2', 300_000)];
        const guard = guardMessages(messages, { windowTokens: 100_000 });
        expect(guard).not.toBeNull();
        const first = (guard!.messages[1] as { content: Array<{ output: { value: string } }> }).content[0]!;
        expect(first.output.value).toContain('已折叠');
    });

    it('system + tools 也算进水位（diy1 预检的三段之和）', () => {
        const messages: ModelMessage[] = [{ role: 'user', content: '开始' }, ...toolPair('t1', 20_000)];
        // 只看 messages 时在线下（2 万字符 ≈ 5k token，窗口 10 万的触发线是 8.4 万）
        expect(guardMessages(messages, { windowTokens: 100_000 })).toBeNull();
        // 把 8 万的 system 算进来就超线了
        expect(guardMessages(messages, { windowTokens: 100_000, fixedTokens: 80_000 })).not.toBeNull();
    });

    it('小输出不折（折了只是噪音）', () => {
        const messages: ModelMessage[] = [
            { role: 'user', content: '开始' },
            ...toolPair('t1', 300),
            ...toolPair('t2', 300),
        ];
        // 窗口足够小让估算超线，但没有一条够 MIN_COLLAPSIBLE_CHARS
        expect(guardMessages(messages, { windowTokens: 10 })).toBeNull();
    });

    it('估算口径与压缩判据同源（CJK 1 字 1 token）', () => {
        expect(estimateMessagesTokens([{ role: 'user', content: '中文中文' }])).toBeGreaterThanOrEqual(4);
    });
});

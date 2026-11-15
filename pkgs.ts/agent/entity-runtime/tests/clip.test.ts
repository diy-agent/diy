// clip.test.ts —— 工具输出的投递层截断（只裁喂模型的那份）。

import { describe, expect, it } from 'vitest';

import { clipModelMessage, clipToolOutput, DEFAULT_CLIP } from '../src/tools/clip';

describe('clipToolOutput', () => {
    it('未超上限：逐字符原样返回', () => {
        const text = 'line1\nline2\n';
        expect(clipToolOutput(text)).toBe(text);
    });

    it('超上限：保头 / 保尾 / 中间给 marker，且带重取提示', () => {
        const lines = Array.from({ length: 4000 }, (_, index) => `第 ${index + 1} 行`);
        const out = clipToolOutput(lines.join('\n'));

        expect(out).toContain('第 1 行');
        expect(out).toContain('第 4000 行');
        expect(out).toContain('中间省略');
        expect(out).toContain('read 的 offset');
        expect(out.length).toBeLessThanOrEqual(DEFAULT_CLIP.maxChars);
        // 中间的内容不再出现
        expect(out).not.toContain('第 2000 行');
    });

    it('单行超长：先截行，再按字符兜底', () => {
        const out = clipToolOutput('x'.repeat(50_000));
        expect(out.length).toBeLessThanOrEqual(DEFAULT_CLIP.maxChars);
        expect(out).toContain('本行已截断');
    });

    it('中文长文本（无换行）也守得住预算', () => {
        const out = clipToolOutput('中'.repeat(30_000));
        expect(out.length).toBeLessThanOrEqual(DEFAULT_CLIP.maxChars);
    });
});

describe('clipModelMessage', () => {
    it('只改 tool 消息的字符串 output，其它消息不动', () => {
        const huge = 'x'.repeat(20_000);
        const tool = clipModelMessage({
            role: 'tool',
            content: [
                { type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: huge } },
            ],
        } as never);
        expect(JSON.stringify(tool).length).toBeLessThan(huge.length);

        const user = { role: 'user' as const, content: huge };
        expect(clipModelMessage(user as never)).toBe(user);
    });

    it('对象型 output 超限时转成裁剪后的文本', () => {
        const value = { rows: Array.from({ length: 5000 }, (_, index) => ({ index })) };
        const tool = clipModelMessage({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'json', value } }],
        } as never);
        const output = (tool.content as Array<{ output: { type: string; value: string } }>)[0]!.output;
        expect(output.type).toBe('text');
        expect(output.value).toContain('中间省略');
    });
});

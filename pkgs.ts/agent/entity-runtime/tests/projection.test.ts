// projection.test.ts —— AgentEvent → Item 的分段语义。
//
// 锁的是一个真实 bug：工具调用前后两段文本如果并成一条 Item，
// 时间线里永远是「全部文本 + 一堆工具」，用户看到的就是"消息不完整"。

import { describe, expect, it } from 'vitest';

import { buildTimeline } from '@diy-agent/chat-core';

import { Projector } from '../src/projection';
import type { AgentEvent, Author, Item } from '../src/types';

const AUTHOR: Author = { id: 'bot:a', name: 'diy', color: '#111', role: 'bot' };

function run(events: AgentEvent[]): Item[] {
    const projector = new Projector(AUTHOR, 1);
    const out: Item[] = [];
    for (const event of events) out.push(...projector.apply(event, 1000));
    // 最后状态（apply 返回的是增量，测试要全量）
    return [...out.reduce((map, item) => map.set(item.id, item), new Map<string, Item>()).values()];
}

describe('Projector', () => {
    it('工具前后两段文本各自成一条 item（text → tool → text）', () => {
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'text.delta', messageId: 'm1', delta: '我先看看文件。' },
            { seq: 3, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'read', args: { path: 'a' } },
            { seq: 4, type: 'tool.completed', turnId: 't1', toolCallId: 'c1', name: 'read', result: 'x' },
            { seq: 5, type: 'text.delta', messageId: 'm1', delta: '结论是它只有两行。' },
            { seq: 6, type: 'message.completed', messageId: 'm1' },
            { seq: 7, type: 'run.completed', turnId: 't1' },
        ]);

        // 按 seq 排序后：文本段1 → 工具 → 文本段2
        const ordered = items.sort((a, b) => a.seq - b.seq);
        expect(ordered.map((item) => item.type)).toEqual(['chat', 'tool', 'chat']);
        expect(ordered[0]?.data).toEqual({ text: '我先看看文件。' });
        expect(ordered[2]?.data).toEqual({ text: '结论是它只有两行。' });
        // 两段是不同 id，前一段在工具开始时就已经收尾
        expect(ordered[0]?.id).not.toBe(ordered[2]?.id);
        expect(ordered[0]?.status).toBe('done');
        expect(ordered[2]?.status).toBe('done');
    });

    it('工具产出的附件 ref 写进 item.data.attachments（view_image 的图给人看）', () => {
        const ref = {
            type: 'stored' as const,
            id: 'ref-img-1',
            kind: 'image' as const,
            mime: 'image/png',
            bytes: 100,
            displayName: 'shot.png',
            source: 'tool' as const,
            createdAt: 1,
            relPath: '2026-11-28/120000-a1b2c3d4/01-shot.png',
        };
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'view_image', args: { path: '/tmp/shot.png' } },
            { seq: 3, type: 'tool.completed', turnId: 't1', toolCallId: 'c1', name: 'view_image', result: '看一眼', attachments: [ref] },
        ]);
        const tool = items.find((item) => item.type === 'tool');
        expect(tool?.type).toBe('tool');
        if (tool?.type !== 'tool') return;
        expect(tool.data.attachments).toEqual([ref]);

        // 一路透传到 timeline 的 tool part，UI 才画得出来
        const timeline = buildTimeline(items);
        const part = timeline[0]?.parts.find((p) => p.kind === 'tool');
        expect(part?.kind).toBe('tool');
        if (part?.kind === 'tool') expect(part.attachments).toEqual([ref]);
    });

    it('时间线把三段还原成 text → tool → text（而不是文本全排在工具前）', () => {
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'text.delta', messageId: 'm1', delta: '先说一句' },
            { seq: 3, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'bash' },
            { seq: 4, type: 'tool.completed', turnId: 't1', toolCallId: 'c1', name: 'bash', result: 'ok' },
            { seq: 5, type: 'text.delta', messageId: 'm1', delta: '再说结论' },
            { seq: 6, type: 'message.completed', messageId: 'm1' },
        ]);

        const timeline = buildTimeline(items);
        expect(timeline).toHaveLength(1);
        expect(timeline[0]?.parts.map((part) => part.kind)).toEqual(['text', 'tool', 'text']);
    });

    it('工具失败：原因落进 data.error（截断成一行），且不留空 result', () => {
        // 2026-11-27：模型吐坏 JSON 时工具是 AI_JSONParseError、根本没有 result，
        // 只存 `state: 'error'` 的话界面上只剩一行「失败 unit_update」，原因得去翻 session_state。
        const long = 'AI_JSONParseError: JSON parsing failed:\n' + 'x'.repeat(2000);
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'unit_update', args: { id: 'u1' } },
            { seq: 3, type: 'tool.completed', turnId: 't1', toolCallId: 'c1', name: 'unit_update', error: long },
        ]);
        const tool = items.find((item) => item.type === 'tool');
        expect(tool?.status).toBe('failed');
        expect(tool?.data).toMatchObject({ state: 'error' });
        expect(tool?.data).not.toHaveProperty('result');
        const message = (tool?.data as { error?: { message: string } }).error?.message ?? '';
        expect(message.startsWith('AI_JSONParseError: JSON parsing failed: x')).toBe(true);
        // 压成一行 + 截断（上限 600 码点，末尾 `…`）
        expect(message).not.toContain('\n');
        expect([...message].length).toBe(601);
        expect(message.endsWith('…')).toBe(true);
    });

    it('run.failed：所有还在 streaming 的条目（含工具）都收尾', () => {
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'text.delta', messageId: 'm1', delta: '先看下文件' },
            { seq: 3, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'ask' },
            { seq: 4, type: 'run.failed', turnId: 't1', message: 'aborted' },
        ]);

        const tool = items.find((item) => item.type === 'tool');
        expect(tool?.status).toBe('failed');
        expect(JSON.stringify(tool)).toContain('"state":"error"');
        expect(items.every((item) => item.status !== 'streaming')).toBe(true);
    });

    it('只有工具、没有文本时，不产生空消息气泡', () => {
        const items = run([
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'bash' },
            { seq: 3, type: 'tool.completed', turnId: 't1', toolCallId: 'c1', name: 'bash', result: 'ok' },
            { seq: 4, type: 'message.completed', messageId: 'm1' },
        ]);

        expect(items.filter((item) => item.type === 'chat')).toHaveLength(0);
    });

    // all() 零生产调用方，但它是「产出序 ≠ seq 序」这条不变量的唯一可执行处：
    // 让这段注释有人守，而不是只有一段话。（见 projection.ts 的 all()）
    it('all() 按产出序返回：同号不能靠 seq 排', () => {
        const projector = new Projector(AUTHOR, 1);
        const events: AgentEvent[] = [
            { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' },
            { seq: 2, type: 'text.delta', messageId: 'm1', delta: '先看下文件' },
            { seq: 3, type: 'tool.started', turnId: 't1', toolCallId: 'c1', name: 'bash' },
        ];
        for (const event of events) projector.apply(event, 1000);

        const items = projector.all();
        expect(items.map((item) => item.type)).toEqual(['chat', 'tool']);
        // 前提：这两条真的同号 —— 否则这条测试守的是一个不存在的风险
        expect(items[0]?.seq).toBe(items[1]?.seq);
    });
});

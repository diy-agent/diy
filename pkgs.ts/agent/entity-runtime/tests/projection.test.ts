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

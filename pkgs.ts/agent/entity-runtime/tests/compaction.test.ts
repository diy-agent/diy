import { describe, expect, it } from 'vitest';

import { createSummaryCompactor, type TranscriptEntry } from '../src/compaction';

const entry = (turn: number, text: string): TranscriptEntry => ({
    message: { role: 'user', content: text },
    origin: 'public',
    turn,
});

describe('summary compactor', () => {
    it('summarizes the removed history and returns the retained entries with a structured summary', async () => {
        let prompt = '';
        const compactor = createSummaryCompactor({
            modelKey: () => 'unused-in-test',
            sessionId: 'bot:test',
            generateSummary: async (input) => {
                prompt = input;
                return JSON.stringify({ conclusions: ['保留结论'], changes: [], todos: [], open: [] });
            },
        });
        const entries = [entry(1, '旧消息甲'), entry(2, '旧消息乙'), entry(3, '最新消息')];

        const result = await compactor.compact({
            entries,
            budget: { keepLast: 1, maxChars: 1 },
            turn: 4,
            turnId: 'turn-4',
            force: true,
        });

        expect(result?.entries).toEqual([entries[2]]);
        expect(result?.dropped).toBe(2);
        expect(result?.summary).toContain('保留结论');
        expect(result?.summarized).toBe(true);
        expect(prompt).toContain('旧消息甲');
        expect(prompt).toContain('旧消息乙');
        expect(prompt).not.toContain('最新消息');
    });

    it('keeps the old summary when summary generation fails', async () => {
        const oldNote: TranscriptEntry = {
            message: { role: 'user', content: '[更早的 1 条消息已折叠]\n\n旧摘要内容' },
            origin: 'note',
        };
        const compactor = createSummaryCompactor({
            modelKey: () => 'unused-in-test',
            sessionId: 'bot:test',
            generateSummary: async () => {
                throw new Error('summary unavailable');
            },
        });
        const entries = [oldNote, entry(1, '中间消息'.repeat(20)), entry(2, '最新消息')];

        const result = await compactor.compact({
            entries,
            budget: { keepLast: 1, maxChars: 20 },
            turn: 3,
            turnId: 'turn-3',
            force: true,
        });

        expect(result?.summary).toContain('旧摘要内容');
        expect(result?.summarized).toBe(false);
    });
});

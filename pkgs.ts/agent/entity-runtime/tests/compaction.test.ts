import { describe, expect, it } from 'vitest';

import { createSummaryCompactor, keepFromOf, simpleCompactor, type TranscriptEntry } from '../src/compaction';

const entry = (turn: number, text: string): TranscriptEntry => ({
    message: { role: 'user', content: text },
    origin: 'public',
    turn,
});

describe('keepTurns', () => {
    it('从尾往前数轮；没有轮号的条目各自算一轮（否则永远压不动）', () => {
        const entries = [entry(1, 'a'), entry(1, 'a2'), entry(2, 'b'), entry(3, 'c'), entry(3, 'c2')];
        expect(keepFromOf(entries, 1)).toBe(3); // 只剩 turn 3
        expect(keepFromOf(entries, 2)).toBe(2);
        expect(keepFromOf(entries, 9)).toBe(0);
        expect(keepFromOf(entries, 0)).toBe(entries.length);

        const untagged: TranscriptEntry[] = [
            { message: { role: 'user', content: 'x' }, origin: 'public' },
            { message: { role: 'user', content: 'y' }, origin: 'public' },
        ];
        expect(keepFromOf(untagged, 1)).toBe(1);
    });
});

describe('simple compactor', () => {
    it('压完仍超上限 ⇒ 不压（空转判据：不做净收益为负的压缩，也不白烧一次摘要）', () => {
        const big = 'x'.repeat(400);
        // turn 1 有可折的 tool，turn 2 是保留区（保 1 轮）且它本身就超预算
        const entries: TranscriptEntry[] = [
            entry(1, big),
            {
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', input: {} }],
                },
                origin: 'self',
                turn: 1,
            },
            {
                message: {
                    role: 'tool',
                    content: [
                        { type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: big } },
                    ],
                },
                origin: 'self',
                turn: 1,
            },
            entry(2, big.repeat(3)),
        ];

        // 折掉 turn 1 的 tool 也回不到 100 字符 ⇒ 宁可不压（否则下一轮还会再压一次）
        expect(simpleCompactor.compact({ entries, budget: { keepTurns: 1, maxChars: 100 }, turn: 2, turnId: 't2' })).toBeNull();

        // 预算给得下去时才真的压（同一条判定线，不是「一律不压」）
        const loose = simpleCompactor.compact({
            entries,
            budget: { keepTurns: 1, maxChars: 2000 },
            turn: 2,
            turnId: 't2',
        });
        expect(loose?.folded).toBeGreaterThan(0);
    });
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
            budget: { keepTurns: 1, maxChars: 1 },
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
            budget: { keepTurns: 1, maxChars: 20 },
            turn: 3,
            turnId: 'turn-3',
            force: true,
        });

        expect(result?.summary).toContain('旧摘要内容');
        expect(result?.summarized).toBe(false);
    });
});

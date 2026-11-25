import { describe, expect, it } from 'vitest';

import { createSummaryCompactor, retainTokensForTurns, simpleCompactor, type TranscriptEntry } from '../src/compaction';

const entry = (turn: number, text: string): TranscriptEntry => ({
    message: { role: 'user', content: text },
    origin: 'public',
    turn,
});

describe('retainTokensForTurns（手工压缩的保留量）', () => {
    it('从尾往前数轮累加 token；没有轮号的条目各自算一轮', () => {
        const entries = [entry(1, 'x'.repeat(400)), entry(1, 'x'.repeat(400)), entry(2, 'x'.repeat(400))];
        // 保 1 轮 = 最后一条；保 2 轮再多 turn 2 那条
        expect(retainTokensForTurns(entries, 1)).toBeLessThan(retainTokensForTurns(entries, 2));
        // 要得比现有轮数多 = 全部（不会凭空加量）
        expect(retainTokensForTurns(entries, 9)).toBe(retainTokensForTurns(entries, 2));
        // 0 = 压到头：保留量给最小（不是 0，判据要求 > 0 才有意义）
        expect(retainTokensForTurns(entries, 0)).toBe(1);

        // 无轮号 ⇒ 各自算一轮，否则「保 2 轮」会变成「保住整段种子」
        const untagged: TranscriptEntry[] = [
            { message: { role: 'user', content: 'x'.repeat(400) }, origin: 'public' },
            { message: { role: 'user', content: 'y'.repeat(400) }, origin: 'public' },
        ];
        expect(retainTokensForTurns(untagged, 1)).toBeLessThan(retainTokensForTurns(untagged, 2));
    });
});

describe('simple compactor（判据来自 @diy-agent/compaction）', () => {
    const turnOf = (turn: number, chars: number): TranscriptEntry => entry(turn, 'x'.repeat(chars));

    it('窗口未知 ⇒ 自动不压（不猜数）', () => {
        const entries = [turnOf(1, 800), turnOf(2, 800)];
        expect(simpleCompactor.compact({ entries, budget: { keepTurns: 1 }, turn: 3, turnId: 't3' })).toBeNull();
    });

    it('没到触发线 ⇒ 不压（不是「每轮都压一次」）', () => {
        const entries = [turnOf(1, 800), turnOf(2, 800)];
        expect(
            simpleCompactor.compact({
                entries,
                budget: { keepTurns: 1 },
                windowTokens: 1_000_000,
                turn: 3,
                turnId: 't3',
            }),
        ).toBeNull();
    });

    it('到触发线 ⇒ 从最老的整轮丢，切点落在轮首', () => {
        // W=20000 ⇒ 触发线 4000 tok、保留 3200 tok；每轮 ≈ 200 tok，21 轮 ≈ 4200 tok
        const entries = Array.from({ length: 21 }, (_, i) => turnOf(i + 1, 800));
        const result = simpleCompactor.compact({
            entries,
            budget: { keepTurns: 1 },
            windowTokens: 20_000,
            turn: 22,
            turnId: 't22',
        });
        expect(result).not.toBeNull();
        expect(result!.dropped).toBeGreaterThan(0);
        // 整段丢：前后条数对得上，且保留区从某一轮的轮首开始（本例每轮一条）
        expect(result!.entries.length + result!.dropped).toBe(entries.length);
        expect(result!.entries[0]!.turn).toBe(result!.dropped + 1);
    });

    it('压完仍超触发线 ⇒ 不压（空转判据：不做净收益为负的压缩，也不白烧一次摘要）', () => {
        // 最后一轮自己就超触发行：怎么切都还是超 ⇒ 宁可不压
        const entries = [...Array.from({ length: 5 }, (_, i) => turnOf(i + 1, 800)), turnOf(6, 120_000)];
        expect(
            simpleCompactor.compact({
                entries,
                budget: { keepTurns: 1 },
                windowTokens: 20_000,
                turn: 7,
                turnId: 't7',
            }),
        ).toBeNull();
    });

    it('手动 force：窗口未知也压，保留量按 keepTurns（0 = 压到头）', () => {
        const entries = [turnOf(1, 800), turnOf(2, 800), turnOf(3, 800)];
        const result = simpleCompactor.compact({
            entries,
            budget: { keepTurns: 1 },
            turn: 4,
            turnId: 't4',
            force: true,
        });
        expect(result?.entries).toHaveLength(1);
        expect(result?.entries[0]?.turn).toBe(3);
        expect(result?.dropped).toBe(2);
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
            budget: { keepTurns: 1 },
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
            budget: { keepTurns: 1 },
            turn: 3,
            turnId: 'turn-3',
            force: true,
        });

        expect(result?.summary).toContain('旧摘要内容');
        expect(result?.summarized).toBe(false);
    });
});

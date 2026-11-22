import { describe, expect, it } from 'vitest';

import { askChipOf, askChipTitleOf, mergePendingAsks, pendingAskHintOf, truncateTitle } from '../src/pendingAsk';

describe('侧栏 ? 的合并规则', () => {
    it('没在看房间：完全照服务端投影', () => {
        expect(mergePendingAsks({ a: 2 }, { a: 1 }, '')).toEqual({ a: 2 });
    });

    it('正在看且流已热：流说 0 就灭，不等 30 秒轮询', () => {
        expect(mergePendingAsks({ a: 2, b: 1 }, { a: 0 }, 'a')).toEqual({ b: 1 });
    });

    it('正在看且流已热：流先说新提问，不必等 /rooms 追上', () => {
        expect(mergePendingAsks({}, { a: 3 }, 'a')).toEqual({ a: 3 });
    });

    it('离开过的房间交回服务端：本地那份冻在离开前，不能一直亮', () => {
        // 看 a 时有 1 条 → 切到 b（a 的订阅被 dispose，本地停在 1）→ 提问在别处答掉，服务端 0
        expect(mergePendingAsks({}, { a: 1 }, 'b')).toEqual({});
        expect(mergePendingAsks({ a: 1 }, { a: 5 }, 'b')).toEqual({ a: 1 });
    });

    it('流还没热身时调用方传空串：本地空快照不吃掉服务端的数', () => {
        expect(mergePendingAsks({ a: 2 }, { a: 0 }, '')).toEqual({ a: 2 });
    });

    it('两边都是 0 时不留空键', () => {
        expect(mergePendingAsks({ a: 0 }, { a: 0 }, 'a')).toEqual({});
    });
});

describe('侧栏 ? 的 tooltip：带上题干（进房间前就知道问的是什么）', () => {
    it('没有题干时只说个数（老服务端 / 投影还没追上）', () => {
        expect(pendingAskHintOf(2, [])).toBe('2 个提问等你回答');
    });

    it('有题干就列出来，一题一个书名号', () => {
        expect(pendingAskHintOf(2, ['方案 A 还是 B？', '环境变量怎么定？'])).toBe(
            '2 个提问等你回答：「方案 A 还是 B？」「环境变量怎么定？」',
        );
    });

    it('题干太长就截断（tooltip 一行装不下整段）', () => {
        const long = '这是一段特别长的题干'.repeat(5);
        expect(truncateTitle(long, 8)).toBe('这是一段特别长的…');
        expect(truncateTitle('短的', 8)).toBe('短的');
    });
});

describe('待答条的 chip：一题报题干、多题报首句 +N', () => {
    it('单题', () => {
        expect(askChipOf([{ question: '用哪个模型？' }])).toBe('用哪个模型？');
    });

    it('多题：首句 + 剩余题数', () => {
        expect(askChipOf([{ question: '口径？' }, { question: '拓扑？' }, { question: '落地到哪？' }])).toBe('口径？ +2');
    });

    it('题干过长截断，但 +N 不能丢', () => {
        const questions = [{ question: '很长很长很长很长很长很长很长很长很长的题干' }, { question: 'b' }];
        const chip = askChipOf(questions, 6);
        expect(chip.endsWith(' +1')).toBe(true);
        expect(chip).toContain('…');
    });

    it('tooltip 逐条列题目（点之前就知道整批问什么）', () => {
        expect(askChipTitleOf([{ question: 'a？' }, { question: 'b？' }])).toBe('还有 2 题等你回答\n· a？\n· b？');
    });
});

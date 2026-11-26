// units-source.test.ts —— 「这条需求来自哪句话」的解引用（纯函数那一半）
//
// 账本要能回答人的第一个问题：「这是我要的吗」。光有消息 id 答不了 —— 所以服务端把
// `unit.source` 解开成「谁 + 原话」（`sourceQuoteOf` / `withSourceQuotes`），界面直接摆在树上。
//
// 这里钉四件事：
//   · 只认**有正文**的条目（chat / notice / error）；tool 条目与缺 author 的不编造
//   · 原话先压成一行、再按**码点**截断（按 UTF-16 切会把 emoji 切半个）
//   · 解不开的来源 = 不给这个键（「不知道」比「编一个」强）
//   · `withSourceQuotes` 不改输入 board（handler 里是 `unitBoard(...)` 之后接着拼）
import { describe, expect, it } from 'vitest';

import type { Item } from '../src/types';
import {
    SOURCE_QUOTE_MAX_CHARS,
    sourceQuoteOf,
    sourceQuotesOf,
    unitBoard,
    withSourceQuotes,
} from '../src/units';

function item(overrides: Partial<Item> & { id: string; type: Item['type'] }): Item {
    return {
        id: overrides.id,
        seq: 1,
        order: 1,
        turn: 1,
        turnId: 'turn-1',
        at: 1,
        status: 'done',
        ...overrides,
    } as Item;
}

const human = { id: 'human:我', name: '我', color: '#888', role: 'human' } as const;
const bot = { id: 'bot-1', name: '任务分解dag', color: '#a3e635', role: 'bot' } as const;

describe('sourceQuoteOf：把一条消息解成「谁 + 原话」', () => {
    it('chat：取 data.text；带上发言人名字与身份', () => {
        const quote = sourceQuoteOf(item({ id: 'u-1', type: 'chat', author: human, data: { text: '需要解决自动拆解' } }));
        expect(quote).toEqual({ author: '我', role: 'human', text: '需要解决自动拆解' });
    });

    it('error：取 data.message（失败原因也是「来源原话」）', () => {
        const quote = sourceQuoteOf(item({ id: 'err-1', type: 'error', author: bot, data: { message: '网关 400' } }));
        expect(quote?.text).toBe('网关 400');
        expect(quote?.role).toBe('bot');
    });

    it('tool 条目没有正文 ⇒ 不编造（返回 undefined）', () => {
        const quote = sourceQuoteOf(
            item({ id: 'tool-1', type: 'tool', author: bot, data: { name: 'bash', state: 'ok' } }),
        );
        expect(quote).toBeUndefined();
    });

    it('缺 author ⇒ 名字空串、role 空串（界面显示「不知是谁」，不写假名字）', () => {
        const quote = sourceQuoteOf(item({ id: 'n-1', type: 'notice', data: { text: '压缩完成', kind: 'compact' } }));
        expect(quote).toEqual({ author: '', role: '', text: '压缩完成' });
    });

    it('多行压成一行、首尾空白去掉（树行上换行会把树撑散）', () => {
        const quote = sourceQuoteOf(
            item({ id: 'u-2', type: 'chat', author: human, data: { text: '  第一行\n\n第二行  ' } }),
        );
        expect(quote?.text).toBe('第一行 第二行');
    });

    it('按码点截断：不把 emoji 切成半个字符，超长以 … 结尾', () => {
        const long = '🙂'.repeat(SOURCE_QUOTE_MAX_CHARS + 5);
        const quote = sourceQuoteOf(item({ id: 'u-3', type: 'chat', author: human, data: { text: long } }));
        expect(quote?.text.endsWith('…')).toBe(true);
        // 去掉省略号后正好是上限个码点，且没有出现半个代理对（U+FFFD / 孤立高位）
        const body = (quote?.text ?? '').slice(0, -1);
        expect([...body]).toHaveLength(SOURCE_QUOTE_MAX_CHARS);
        expect(body.includes('\uFFFD')).toBe(false);
    });
});

describe('sourceQuotesOf / withSourceQuotes：贴到树上', () => {
    const board = () =>
        unitBoard([
            { id: 'has', title: '有来源', status: 'open', seq: 1, source: 'u-1', accept: '有单测' },
            { id: 'nope', title: '来源已剪', status: 'open', seq: 2, source: 'u-gone', accept: '有单测' },
            { id: 'old', title: '老数据没来源', status: 'open', seq: 3, accept: '有单测' },
        ]);

    it('只给能解开的行贴；解不开 / 没来源的行保持原样（不编造）', () => {
        const quotes = sourceQuotesOf([
            item({ id: 'u-1', type: 'chat', author: human, data: { text: '要有导出' } }),
        ]);
        const attached = withSourceQuotes(board(), quotes);
        const byId = new Map(attached.rows.map((row) => [row.id, row] as const));
        expect(byId.get('has')?.sourceQuote).toEqual({ author: '我', role: 'human', text: '要有导出' });
        expect(byId.get('nope')?.sourceQuote).toBeUndefined();
        expect(byId.get('old')?.sourceQuote).toBeUndefined();
    });

    it('不改输入 board（handler 里是 unitBoard(...) 之后接着拼）', () => {
        const original = board();
        const quotes = sourceQuotesOf([item({ id: 'u-1', type: 'chat', author: human, data: { text: '要有导出' } })]);
        withSourceQuotes(original, quotes);
        expect(original.rows.every((row) => row.sourceQuote === undefined)).toBe(true);
    });

    it('没取到任何原话时原样返回（省一次行拷贝）', () => {
        const original = board();
        expect(withSourceQuotes(original, new Map())).toBe(original);
    });
});

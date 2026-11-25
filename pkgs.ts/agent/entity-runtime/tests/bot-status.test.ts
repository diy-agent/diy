import { describe, expect, it } from 'vitest';
import { botLastTurnOf, needsHuman, outcomeText } from '../src/bot-status';
import { openStore } from '../src/db';
import type { Item } from '../src/types';

let counter = 0;

/** 造一条最小可用的 item（seq 交给 appendItem 补） */
function item(partial: Partial<Item> & { type: Item['type']; data: unknown }, author?: string): Item {
    counter += 1;
    return {
        id: `i${counter}`,
        seq: 0,
        turnId: 'turn-1',
        turn: 1,
        at: 1000 + counter,
        status: 'done',
        ...(author === undefined ? {} : { author: { id: author, name: author, color: '#000', role: 'bot' } }),
        ...partial,
    } as Item;
}

const chat = (author?: string, turnId = 'turn-1'): Item =>
    item({ type: 'chat', data: { text: 'hi' }, turnId }, author);
const notice = (kind: string, author?: string): Item => item({ type: 'notice', data: { text: kind, kind } }, author);
const errorItem = (message: string, author?: string): Item =>
    item({ type: 'error', data: { message } }, author);

describe('lastItemPerBot', () => {
    it('每个 bot 各取最后一条，不串房间', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', chat('a'));
        store.appendItem('r1', chat('b'));
        store.appendItem('r1', notice('max-tokens', 'a'));
        store.appendItem('r2', errorItem('boom', 'a'));

        const rows = store.lastItemPerBot(['r1']).sort((x, y) => x.item.seq - y.item.seq);
        expect(rows).toHaveLength(2);
        const a = rows.find((row) => row.item.author?.id === 'a');
        const b = rows.find((row) => row.item.author?.id === 'b');
        expect(a?.roomId).toBe('r1');
        expect(a?.item.type).toBe('notice');
        expect(a?.item.data).toEqual({ text: 'max-tokens', kind: 'max-tokens' });
        expect(b?.item.type).toBe('chat');
    });

    it('不给房间 = 全实例一张表', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', chat('a'));
        store.appendItem('r2', chat('b'));
        const rooms = store.lastItemPerBot().map((row) => row.roomId);
        expect(new Set(rooms)).toEqual(new Set(['r1', 'r2']));
    });

    it('没有 author 的条目不参与分组', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', item({ type: 'chat', data: { text: 'system' } }));
        expect(store.lastItemPerBot()).toHaveLength(0);
    });

    it('seq 是入库后的真值，不是入参里的 0', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', chat('a'));
        store.appendItem('r1', chat('a'));
        const [row] = store.lastItemPerBot();
        expect(row?.item.seq).toBeGreaterThan(0);
    });
});

describe('botLastTurnOf', () => {
    it('最后一条是 error → failed 并带原文', () => {
        const turn = botLastTurnOf('r1', errorItem('网关 500', 'a'));
        expect(turn).toMatchObject({ roomId: 'r1', botId: 'a', outcome: 'failed', message: '网关 500' });
    });

    it.each([
        ['max-tokens', 'truncated'],
        ['max-steps', 'max-steps'],
        ['content-filter', 'filtered'],
        ['tool-mismatch', 'tool-mismatch'],
    ])('notice %s → %s', (kind, outcome) => {
        expect(botLastTurnOf('r1', notice(kind, 'a'))?.outcome).toBe(outcome);
    });

    it('普通产出与作业通知都算正常结束', () => {
        expect(botLastTurnOf('r1', chat('a'))?.outcome).toBe('done');
        expect(botLastTurnOf('r1', notice('job-done', 'a'))?.outcome).toBe('done');
    });

    it('没有 author 的条目没有「上一轮」', () => {
        expect(botLastTurnOf('r1', chat())).toBeUndefined();
    });

    it('保留 turnId / turn / at，供表格排序', () => {
        const turn = botLastTurnOf('r1', chat('a', 'turn-7'));
        expect(turn?.turnId).toBe('turn-7');
        expect(turn?.turn).toBe(1);
        expect(turn?.at).toBeGreaterThan(0);
    });
});

describe('needsHuman / outcomeText', () => {
    it('只有 done 不需要人动手', () => {
        expect(needsHuman('done')).toBe(false);
        for (const outcome of ['truncated', 'max-steps', 'filtered', 'tool-mismatch', 'failed'] as const) {
            expect(needsHuman(outcome)).toBe(true);
        }
    });

    it('失败带原文，其余给固定文案', () => {
        expect(outcomeText('failed', '网关 500')).toBe('失败：网关 500');
        expect(outcomeText('failed')).toBe('运行失败');
        expect(outcomeText('truncated')).toBe('被输出上限截断');
    });
});

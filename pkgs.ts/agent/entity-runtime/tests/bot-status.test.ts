import { describe, expect, it } from 'vitest';
import { botLastTurnOf, needsHuman, outcomeOfFact, outcomeText, withTurnFact } from '../src/bot-status';
import { endItems } from '../src/end-reason';
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

describe('outcomeOfFact / withTurnFact', () => {
    it('轮级事实自成结局，不看 author', () => {
        expect(outcomeOfFact(item({ type: 'error', data: { message: '网关 500' } }))).toEqual({
            outcome: 'failed',
            message: '网关 500',
        });
        expect(outcomeOfFact(notice('max-tokens'))?.outcome).toBe('truncated');
        expect(outcomeOfFact(notice('interrupted'))?.outcome).toBe('interrupted');
    });

    it('不是结局的条目返回 undefined', () => {
        expect(outcomeOfFact(chat())).toBeUndefined();
        expect(outcomeOfFact(notice('job-done'))).toBeUndefined();
    });

    it('把那一轮的事实盖到 bot 的结局上', () => {
        const done = botLastTurnOf('r1', chat('a'));
        expect(done?.outcome).toBe('done');
        expect(withTurnFact(done!, notice('max-tokens')).outcome).toBe('truncated');
        // 没有事实 / 事实不是结局 → 原样，不能把「正常结束」洗成别的
        expect(withTurnFact(done!, undefined).outcome).toBe('done');
        expect(withTurnFact(done!, notice('job-done')).outcome).toBe('done');
    });

    it('error 事实把原文带到 message', () => {
        const turn = withTurnFact(botLastTurnOf('r1', chat('a'))!, item({ type: 'error', data: { message: '网关 500' } }));
        expect(turn).toMatchObject({ outcome: 'failed', message: '网关 500' });
    });

    it('endItems 落的结局带 botId（归属不丢，UI 仍独立成条）', () => {
        const [fact] = endItems({ type: 'max-tokens', maxOutputTokens: 100 }, { turn: 1, turnId: 'turn-1', botId: 'bot:a' });
        expect(fact?.type).toBe('notice');
        // 不带 author：UI 据此让它独立成条（timeline 的分组看 author 在不在）
        expect(fact?.author).toBeUndefined();
        expect(fact?.type === 'notice' ? fact.data.botId : undefined).toBe('bot:a');
    });
});

describe('lastFactPerTurn', () => {
    // 轮级事实（endItems 落的 notice / error）不带 author —— 这正是它进不了
    // `lastItemPerBot` 的原因，也是这里必须按 turnId 单独查一圈的原因。
    it('同一轮多条只取最后一条', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', notice('max-tokens'));
        store.appendItem('r1', item({ type: 'notice', data: { text: 'later', kind: 'job-done' } }));
        const rows = store.lastFactPerTurn(['r1']);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.item.data).toEqual({ text: 'later', kind: 'job-done' });
    });

    it('按 turnId 分开，不跨轮', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', notice('max-tokens'));
        store.appendItem('r1', item({ type: 'error', data: { message: 'boom' }, turnId: 'turn-2' }));
        const rows = store.lastFactPerTurn(['r1']).sort((x, y) => x.item.seq - y.item.seq);
        expect(rows.map((row) => row.item.turnId)).toEqual(['turn-1', 'turn-2']);
    });

    it('带 author 的 notice 不算轮级事实（那是 bot 自己的话）', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', notice('max-tokens', 'a'));
        expect(store.lastFactPerTurn(['r1'])).toHaveLength(0);
    });

    it('不给房间 = 全实例一张表', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', notice('max-tokens'));
        store.appendItem('r2', notice('interrupted'));
        expect(new Set(store.lastFactPerTurn().map((row) => row.roomId))).toEqual(new Set(['r1', 'r2']));
    });

    // turnId 是**房间级**的（@all 的各 bot 共享一个），所以归属不能只靠它。
    it('带 botId 时按 bot 分组：同一轮的两个 bot 各认各的', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', item({ type: 'notice', data: { text: 'A 截断', kind: 'max-tokens', botId: 'a' } }));
        store.appendItem('r1', item({ type: 'notice', data: { text: 'B 步数', kind: 'max-steps', botId: 'b' } }));
        const rows = store.lastFactPerTurn(['r1']).sort((x, y) => x.owner.localeCompare(y.owner));
        // 两条都是 turn-1；只按 turnId 分会塌成一条，就是张冠李戴的开始
        expect(rows.map((row) => row.owner)).toEqual(['a', 'b']);
        expect(rows.map((row) => row.item.data.kind)).toEqual(['max-tokens', 'max-steps']);
    });

    it('老数据没有 botId：owner 退回 turnId', () => {
        const store = openStore(':memory:');
        store.appendItem('r1', notice('max-tokens'));
        expect(store.lastFactPerTurn(['r1'])[0]?.owner).toBe('turn-1');
    });
});

describe('needsHuman / outcomeText', () => {
    it('只有 done 不需要人动手', () => {
        expect(needsHuman('done')).toBe(false);
        for (const outcome of ['truncated', 'max-steps', 'filtered', 'tool-mismatch', 'interrupted', 'failed'] as const) {
            expect(needsHuman(outcome)).toBe(true);
        }
    });

    it('失败带原文，其余给固定文案', () => {
        expect(outcomeText('failed', '网关 500')).toBe('失败：网关 500');
        expect(outcomeText('failed')).toBe('运行失败');
        expect(outcomeText('truncated')).toBe('被输出上限截断');
        expect(outcomeText('interrupted')).toBe('中断（上一轮没跑完）');
    });
});

// end-footer.test.ts —— 「这一轮是怎么停的」在页脚怎么显示（文案 + 挂在哪一段）。
//
// 锁三件事：
//   · 文案只认 `type`/`note`（三个 surface 共用 `endFooterOf`，不许各写一份）；
//   · `buildTimeline` 把它挂在**该轮最后一段**上 —— 被插话切成多段时只出现一次；
//   · 结局按「轮 + 成员」取 —— 同一轮里 A 被截断、B 正常说完，两人的页脚不能是同一个
//     （`reduce` 写的 key 就是 `turnId\0botId`，两边必须是同一个形状）。

import { describe, expect, it } from 'vitest';

import { endFooterOf } from '../src/end-footer';
import { applyEvent, emptyState } from '../src/reduce';
import { buildTimeline } from '../src/timeline';
import type { Item, TurnEndReason } from '../src/types';

const bot = { id: 'bot:a', name: 'diy', color: '#111', role: 'bot' as const };

function chat(seq: number, text: string, turnId = 't1'): Item {
    return {
        id: `i${seq}`,
        seq,
        order: seq,
        turn: 1,
        turnId,
        at: 1_700_000_000_000 + seq,
        status: 'done',
        author: bot,
        type: 'chat',
        data: { text },
    } as Item;
}

describe('endFooterOf', () => {
    it('正常收尾不占页脚（"没有那行"才是正常的信号）', () => {
        expect(endFooterOf({ type: 'completed' })).toBeUndefined();
        expect(endFooterOf(undefined)).toBeUndefined();
    });

    it('截断：说清是哪一层的上限，并告诉用户「继续」能接上', () => {
        const footer = endFooterOf({ type: 'max-tokens', maxOutputTokens: 8192 });
        expect(footer?.label).toBe('被输出上限截断');
        expect(footer?.detail).toContain('8192');
        expect(footer?.detail).toContain('继续');
        expect(footer?.tone).toBe('warn');
    });

    it('工具悬空：补救动作是"重跑这一步"，不是续写', () => {
        const footer = endFooterOf({ type: 'tool-mismatch', finishReason: 'tool-calls' });
        expect(footer?.label).toBe('工具结果没回来');
        expect(footer?.detail).not.toContain('接上');
    });

    it('人按的停：中性色，不吓人', () => {
        const footer = endFooterOf({ type: 'interrupted', finishReason: 'aborted' });
        expect(footer?.tone).toBe('muted');
        expect(footer?.label).toContain('停止');
    });

    it('「没收到结束信号」按失败说，且不装懂原因', () => {
        const footer = endFooterOf({ type: 'unknown', note: 'no-finish' });
        expect(footer?.tone).toBe('bad');
        expect(footer?.detail).toContain('没收到结束信号');
    });

    it('每一种判定都有话可说（不许静默 → 那正是原来的 bug）', () => {
        const reasons: TurnEndReason[] = [
            { type: 'max-tokens' },
            { type: 'filtered' },
            { type: 'tool-mismatch' },
            { type: 'interrupted' },
            { type: 'unknown', note: 'empty-output' },
            { type: 'unknown', note: 'finish=eos' },
            { type: 'error' },
        ];
        for (const reason of reasons) expect(endFooterOf(reason), reason.type).toBeDefined();
    });
});

describe('buildTimeline 把结局挂在该轮最后一段', () => {
    it('被插话切成两段时，页脚只挂在第二段', () => {
        const items = [chat(1, '先说一段'), chat(2, '接着说')];
        const entries = buildTimeline(
            items,
            [],
            {},
            { endReasons: { t1: { type: 'max-tokens', maxOutputTokens: 8192 } } },
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.endReason?.type).toBe('max-tokens');
    });

    it('中间插进别人的话 → 分成两条，结局仍只出现在本条作者的最后一段', () => {
        const other = { ...bot, id: 'bot:b', name: 'cops' };
        const items: Item[] = [
            chat(1, '我的前半句'),
            { ...chat(2, '别人的话'), author: other } as Item,
            chat(3, '我的后半句'),
        ];
        const entries = buildTimeline(items, [], {}, { endReasons: { t1: { type: 'interrupted' } } });
        const mine = entries.filter((entry) => entry.author?.id === 'bot:a');

        expect(mine).toHaveLength(2);
        expect(mine[0]?.endReason).toBeUndefined();
        expect(mine[1]?.endReason?.type).toBe('interrupted');
    });

    it('没有 turn.end 事实时不做任何猜测', () => {
        const entries = buildTimeline([chat(1, '一段话')]);
        expect(entries[0]?.endReason).toBeUndefined();
    });

    it('这一轮没说话（空产出 / 直接失败）：结局退到该轮最后一条条目上，不留空', () => {
        const error: Item = {
            id: 'e1',
            seq: 5,
            order: 5,
            turn: 1,
            turnId: 't1',
            at: 1_700_000_000_005,
            status: 'done',
            type: 'error',
            data: { message: '模型一个字都没说就结束了' },
        } as Item;
        const entries = buildTimeline(
            [error],
            [],
            {},
            {
                endReasons: { t1: { type: 'unknown', note: 'empty-output' } },
            },
        );
        expect(entries[0]?.kind).toBe('error');
        expect(entries[0]?.endReason?.note).toBe('empty-output');
    });

    it('同一轮里两个 bot 各停一种：页脚各归各的，不许互相覆盖', () => {
        // 事件走真 `reduce`（key 形状由它定），时间线只负责按同一个形状取
        const other = { id: 'bot:b', name: 'cops', color: '#222', role: 'bot' as const };
        const items = [chat(1, 'A 说到一半'), { ...chat(2, 'B 说完了'), author: other } as Item];
        let state = emptyState();
        state = applyEvent(state, {
            kind: 'turn.end',
            turnId: 't1',
            botId: 'bot:a',
            reason: { type: 'max-tokens', maxOutputTokens: 8192 },
        });
        state = applyEvent(state, { kind: 'turn.end', turnId: 't1', botId: 'bot:b', reason: { type: 'completed' } });

        const entries = buildTimeline(items, [], {}, { endReasons: state.turnEnds });
        const a = entries.find((entry) => entry.kind === 'assistant' && entry.author?.id === 'bot:a');
        const b = entries.find((entry) => entry.kind === 'assistant' && entry.author?.id === 'bot:b');
        expect(a?.endReason?.type).toBe('max-tokens');
        expect(b?.endReason?.type).toBe('completed');
        expect(endFooterOf(b?.endReason)).toBeUndefined();
    });

    it('bot 有话说时只挂在 bot 段上（notice 不重复显示结局）', () => {
        const notice: Item = {
            id: 'n1',
            seq: 9,
            order: 9,
            turn: 1,
            turnId: 't1',
            at: 1_700_000_000_010,
            status: 'done',
            type: 'notice',
            data: { text: '被截断了', kind: 'max-tokens' },
        } as Item;
        const entries = buildTimeline(
            [chat(1, '半句话'), notice],
            [],
            {},
            {
                endReasons: { t1: { type: 'max-tokens' } },
            },
        );
        const speech = entries.find((entry) => entry.kind === 'assistant');
        const noticeEntry = entries.find((entry) => entry.kind === 'notice');
        expect(speech?.endReason?.type).toBe('max-tokens');
        expect(noticeEntry?.endReason).toBeUndefined();
    });
});

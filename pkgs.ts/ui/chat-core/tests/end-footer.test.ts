// end-footer.test.ts —— 「这一轮是怎么停的」在页脚怎么显示（文案 + 挂在哪一段）。
//
// 锁三件事：
//   · 文案只认 `type`/`note`（三个 surface 共用 `endFooterOf`，不许各写一份）；
//   · `buildTimeline` 把它挂在**该轮最后一条 bot 回复**上 —— 只出现一次
//     （一个 bot 一轮只有一条，所以"最后一段"和"这一条"是同一个东西）；
//   · 结局按「轮 + 成员」取 —— 同一轮里 A 被截断、B 正常说完，两人的页脚不能是同一个
//     （`reduce` 写的 key 就是 `turnId\0botId`，两边必须是同一个形状）。

import { describe, expect, it } from 'vitest';

import { endFooterOf, settleFactsOf, turnSettleOf } from '../src/end-footer';
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

    it('失联：说清在等谁、空了多久（不是「不知道」）', () => {
        const footer = endFooterOf({ type: 'stalled', awaiting: 'model-stream', idleMs: 120_000 });
        expect(footer?.label).toBe('本轮失联');
        expect(footer?.tone).toBe('bad');
        expect(footer?.detail).toContain('等模型回话');
        expect(footer?.detail).toContain('120s');
        // 机器码不能直接端给用户
        expect(footer?.detail).not.toContain('model-stream');
    });

    it('失联在工具上：说哪个工具在跑', () => {
        const footer = endFooterOf({ type: 'stalled', awaiting: 'tool:bash', idleMs: 300_000 });
        expect(footer?.detail).toContain('bash 在跑');
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
            { type: 'stalled' },
            { type: 'unknown', note: 'empty-output' },
            { type: 'unknown', note: 'finish=eos' },
            { type: 'error' },
        ];
        for (const reason of reasons) expect(endFooterOf(reason), reason.type).toBeDefined();
    });
});

describe('buildTimeline 把结局挂在该轮最后一段', () => {
    it('一轮一条：页脚就是这条的，不会重复', () => {
        const items = [chat(1, '先说一段'), chat(2, '接着说')];
        const entries = buildTimeline(
            items,
            [],
            {},
            { turns: { t1: { reason: { type: 'max-tokens', maxOutputTokens: 8192 } } } },
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.turn?.reason?.type).toBe('max-tokens');
    });

    it('中间插进别人的话也不分段：结局只出现一次', () => {
        const other = { ...bot, id: 'bot:b', name: 'cops' };
        const items: Item[] = [
            chat(1, '我的前半句'),
            { ...chat(2, '别人的话'), author: other } as Item,
            chat(3, '我的后半句'),
        ];
        const entries = buildTimeline(items, [], {}, { turns: { t1: { reason: { type: 'interrupted' } } } });
        const mine = entries.filter((entry) => entry.author?.id === 'bot:a');

        // 一个 bot 一轮只说一条（位置在首次出现处），后来插入的别人的话不会把它切开
        expect(mine).toHaveLength(1);
        expect(mine[0]?.parts).toEqual([
            { kind: 'text', text: '我的前半句' },
            { kind: 'text', text: '我的后半句' },
        ]);
        expect(mine[0]?.turn?.reason?.type).toBe('interrupted');
    });

    it('没有 turn.end 事实时不做任何猜测', () => {
        const entries = buildTimeline([chat(1, '一段话')]);
        expect(entries[0]?.turn).toBeUndefined();
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
                turns: { t1: { reason: { type: 'unknown', note: 'empty-output' } } },
            },
        );
        expect(entries[0]?.kind).toBe('error');
        expect(entries[0]?.turn?.reason?.note).toBe('empty-output');
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

        const entries = buildTimeline(items, [], {}, { turns: state.turns });
        const a = entries.find((entry) => entry.kind === 'assistant' && entry.author?.id === 'bot:a');
        const b = entries.find((entry) => entry.kind === 'assistant' && entry.author?.id === 'bot:b');
        expect(a?.turn?.reason?.type).toBe('max-tokens');
        expect(b?.turn?.reason?.type).toBe('completed');
        expect(endFooterOf(b?.turn?.reason)).toBeUndefined();
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
                turns: { t1: { reason: { type: 'max-tokens' } } },
            },
        );
        const speech = entries.find((entry) => entry.kind === 'assistant');
        const noticeEntry = entries.find((entry) => entry.kind === 'notice');
        expect(speech?.turn?.reason?.type).toBe('max-tokens');
        expect(noticeEntry?.turn).toBeUndefined();
    });
});

describe('结算行（轮次最下面那行）', () => {
    it('还在跑：没有 endedAt 就不给结算（那时画的是「已用 Ns」）', () => {
        expect(turnSettleOf({ startedAt: 1 })).toBeUndefined();
        expect(settleFactsOf({ startedAt: 1 })).toEqual([]);
    });

    it('正常收尾也要说「完成」：页脚对 completed 沉默，结算行不能沉默', () => {
        // 这一行本来就是「这一轮到止」的分界；空着的话一段话孤零零停在那里，
        // 用户分不清是跑完了还是断了
        expect(turnSettleOf({ endedAt: 2, reason: { type: 'completed' } })?.label).toBe('完成');
    });

    it('异常收尾用页脚那套标签（同一份文案，不许另写）', () => {
        const reason = { type: 'max-tokens', maxOutputTokens: 100 } as const;
        const settle = turnSettleOf({ endedAt: 2, reason });
        expect(settle?.label).toBe(endFooterOf(reason)?.label);
        expect(settle?.tone).toBe('warn');
    });

    it('事实片段只写真的有数的项（耗时 / tokens / 步数 / 工具次数）', () => {
        const facts = settleFactsOf({
            startedAt: 1_000,
            endedAt: 1_000 + 192_000,
            usage: { inputTokens: 12_000, outputTokens: 400 },
            toolCalls: 2,
            reason: { type: 'completed', steps: 7 },
        });
        expect(facts).toEqual(['3m12s', '12.4k tokens', '7 步', '2 次工具']);
    });

    it('拿不到的数一律不写：0 tokens / 0 步不冒充事实', () => {
        const facts = settleFactsOf({
            startedAt: 1_000,
            endedAt: 2_000,
            usage: { inputTokens: 0, outputTokens: 0 },
            reason: { type: 'completed', steps: 0 },
        });
        expect(facts).toEqual(['1s']);
    });

    it('工具次数既可在 turn 上也可在 reason 上（老数据），不要写两遍', () => {
        const facts = settleFactsOf({
            startedAt: 1_000,
            endedAt: 2_000,
            toolCalls: 3,
            reason: { type: 'completed', steps: 2, toolCalls: 3 },
        });
        expect(facts.filter((fact) => fact.includes('次工具'))).toEqual(['3 次工具']);
    });
});

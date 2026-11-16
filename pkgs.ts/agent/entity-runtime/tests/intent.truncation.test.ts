// intent.truncation.test.ts —— 「执行一半就停下，UI 却显示完成」这个 bug 的护栏。
//
// 背景：AI SDK 在 `finishReason === "length"`（撞输出上限）时**只结束循环、不发 error part**
// （`node_modules/ai/dist/index.js` 的 `shouldStartNextStep`）。以前我们既不传 `max_tokens`、
// 也不读 `finish` part，于是「被截断」和「正常说完」在数据里一模一样。
//
// 这里锁三件事：
//   1. 收尾事实落到 `TurnResult.endReason`（max-tokens / tool-mismatch / interrupted / completed）；
//   2. 截断必须留一条 `notice`（用户能看见「说继续可接上」），且能落库；
//   3. `max_tokens` 必须显式算出来（不发 = 吃服务端缺省 = 静默截断）。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import { DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensOf } from '../src/providers';
import { BotSession, type SessionDeps, type Turn, type TurnResult } from '../src/session';
import type { AgentEvent, Bot, Item, TurnEndReason } from '../src/types';
import { HUMAN, makeRoom, waitFor } from './support/harness';

const BOT: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '', homeRoomId: 'room:1', modelKey: 'm' };

interface End {
    result: TurnResult;
    items: Item[];
}

/** 一次 run，只在「收尾事实」上不同 */
function runEndingWith(finishReason: string, steps = 3) {
    return async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        const turnId = input.turnId ?? 'turn';
        const messageId = 'msg-1';
        yield { seq: 1, type: 'run.started', turnId, messageId };
        yield { seq: 2, type: 'text.delta', messageId, delta: '写到一半的结论' };
        input.onStepTranscript?.([{ role: 'assistant', content: [{ type: 'text', text: '写到一半的结论' }] }]);
        yield {
            seq: 3,
            type: 'run.finished',
            turnId,
            finishReason,
            steps,
            maxOutputTokens: input.maxOutputTokens ?? 0,
        };
        yield { seq: 4, type: 'message.completed', messageId };
        yield { seq: 5, type: 'run.completed', turnId };
    };
}

async function sessionEndingWith(finishReason: string): Promise<End> {
    const items: Item[] = [];
    const ends: TurnResult[] = [];
    let turn = 0;
    const session = new BotSession({
        bot: BOT,
        modelKey: 'm',
        allocateTurn: (): Turn => ({ turn: ++turn, turnId: `turn-${turn}` }),
        run: runEndingWith(finishReason) as SessionDeps['run'],
    });
    session.subscribe((event) => {
        if (event.type === 'item') items.push(event.item);
        if (event.type === 'turn.end') ends.push(event.result);
    });
    await session.post({ messageId: 'm1', text: '开始干' });
    expect(ends).toHaveLength(1);
    return { result: ends[0]!, items };
}

describe('收尾事实：截断不能长得像「完成」', () => {
    it('finishReason=length → endReason.max-tokens（带上实际发出去的上限）', async () => {
        const { result, items } = await sessionEndingWith('length');
        const reason: TurnEndReason = result.endReason;
        expect(reason.type).toBe('max-tokens');
        expect(reason.finishReason).toBe('length');
        expect(reason.maxOutputTokens).toBeGreaterThan(0);
        expect(reason.steps).toBe(3);

        // 用户必须看得见：一条 notice，「说继续可接上」
        const notice = items.find((item) => item.type === 'notice');
        expect(notice?.type === 'notice' && notice.data.kind).toBe('max-tokens');
        expect(notice?.type === 'notice' && notice.data.text).toContain('说「继续」可接上'.slice(0, 3));
    });

    it('finishReason=stop → completed，不产生 notice', async () => {
        const { result, items } = await sessionEndingWith('stop');
        expect(result.endReason.type).toBe('completed');
        expect(items.some((item) => item.type === 'notice')).toBe(false);
    });

    it('finishReason=tool-calls（工具结果没回来）→ tool-mismatch，不算截断', async () => {
        const { result, items } = await sessionEndingWith('tool-calls');
        expect(result.endReason.type).toBe('tool-mismatch');
        // 两者的补救动作不同：一个补工具结果、一个续写，不能混成同一个提示
        expect(items.some((item) => item.type === 'notice' && item.data.kind === 'max-tokens')).toBe(false);
    });

    it('content-filter 单独一类：补救动作是换说法/换模型，不是「继续」', async () => {
        const { result, items } = await sessionEndingWith('content-filter');
        expect(result.endReason.type).toBe('filtered');
        // 不能给「说继续可接上」—— 被策略拦住的续写只会再被拦一次
        expect(items.some((item) => item.type === 'notice' && item.data.kind === 'content-filter')).toBe(true);
    });
});

describe('截断的 notice 要能落库（刷新后还在）', () => {
    it('房间层：notice 进 items() 且重启后可读', async () => {
        const h = makeRoom({ run: runEndingWith('length') as SessionDeps['run'] });
        await h.room.say({ text: '开始干', author: HUMAN });

        await waitFor(() => h.items().some((item) => item.type === 'notice'));
        expect(h.items().some((item) => item.type === 'notice' && item.data.kind === 'max-tokens')).toBe(true);
        expect(
            h
                .rebuild()
                .items()
                .some((item) => item.type === 'notice'),
        ).toBe(true);
    });
});

describe('max_tokens 必须显式算出来', () => {
    it('deepseek 走 provider 硬上限（发超了会被 400）', () => {
        expect(maxOutputTokensOf('chen56@deepseek/deepseek-chat')).toBe(8192);
    });

    it('其它 provider 用场景缺省（对齐老路径 16384）', () => {
        expect(maxOutputTokensOf('chen56@opencode-go/deepseek-v4.1-flash')).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
        expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16_384);
    });

    it('调用方显式值优先于缺省；env 又优先于调用方（线上可临时收窄）', () => {
        expect(maxOutputTokensOf('chen56@opencode-go/x', 4321)).toBe(4321);
        process.env.DIY_LOCAL_MAX_OUTPUT_TOKENS = '999';
        try {
            expect(maxOutputTokensOf('chen56@opencode-go/x', 4321)).toBe(999);
        } finally {
            delete process.env.DIY_LOCAL_MAX_OUTPUT_TOKENS;
        }
    });

    it('非法值不往下发（SDK 会直接拒 0 / 负数）', () => {
        expect(maxOutputTokensOf('chen56@opencode-go/x', 0)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
        expect(maxOutputTokensOf('chen56@opencode-go/x', -5)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });
});

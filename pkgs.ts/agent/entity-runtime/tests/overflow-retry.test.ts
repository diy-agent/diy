// overflow-retry.test.ts —— 超窗 400 的自愈路径（2026-11-27 实证的洞）。
//
// 现场：压缩只在**轮首**判一次，200 步的轮次能把请求从 20 万堆到 100 万，网关回
// `context_length_exceeded`；旧行为把它当普通 400 ⇒ 整轮作废，且失败步已落 transcript
// ⇒ 下一轮起步即爆。这里锁两条：
//   · 认得出 ⇒ 压一次、整轮重发，用户看不到那条英文报错，也看不到「超窗失败」条目；
//   · 认不出 / 压完还超 ⇒ 只报一次中文结论（不重试、不重复报）。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import { simpleCompactor } from '../src/compaction';
import { BotSession, type SessionDeps, type SessionEvent, type Turn } from '../src/session';
import type { AgentEvent, Bot, Item } from '../src/types';

const BOT: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '', homeRoomId: 'room:1', modelKey: 'm' };
/** agent 层已经把上游原文翻成了人话（`friendlyError(isContextOverflow)`），session 拿到的就是它 */
const OVERFLOW = '这次请求的上下文超过了模型窗口，自动压缩后仍然装不下。换一个窗口更大的模型，或在这个房间里开一个新会话。';

/** 一份能真的压出东西的种子：早期一轮里有工具调用 + 大输出（`SessionDeps.seed` 是个工厂） */
const SEED: NonNullable<ReturnType<NonNullable<SessionDeps['seed']>>> = {
    entries: [
        { message: { role: 'user' as const, content: '早期需求' }, origin: 'public' as const, turn: 1 },
        {
            message: {
                role: 'assistant' as const,
                content: [{ type: 'tool-call' as const, toolCallId: 't1', toolName: 'read', input: {} }],
            },
            origin: 'self' as const,
            turn: 1,
        },
        {
            message: {
                role: 'tool' as const,
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 't1',
                        toolName: 'read',
                        output: { type: 'text' as const, value: '工具输出'.repeat(500) },
                    },
                ],
            },
            origin: 'self' as const,
            turn: 1,
        },
        {
            message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '结论：已修复' }] },
            origin: 'self' as const,
            turn: 1,
        },
        { message: { role: 'user' as const, content: '最新一句' }, origin: 'public' as const, turn: 2 },
    ],
};

interface Harness {
    session: BotSession;
    runs: RunOptions['messages'][];
    items: Item[];
    events: SessionEvent[];
}

/** 前 `overflowTimes` 次开跑吐带 `overflow` 的 run.failed，之后正常收尾 */
function makeSession(overflowTimes: number, opts: { overflowFlag?: boolean } = {}): Harness {
    const runs: RunOptions['messages'][] = [];
    const items: Item[] = [];
    const events: SessionEvent[] = [];
    let turn = 0;

    const run = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        const turnId = input.turnId ?? 'turn';
        runs.push(input.messages);
        yield { seq: 1, type: 'run.started', turnId, messageId: `msg-${runs.length}` };
        if (runs.length <= overflowTimes) {
            yield {
                seq: 2,
                type: 'run.failed',
                turnId,
                // 判据在 agent 层；这里模拟它把事实带上来（overflowFlag=false 用来锁「别认成超窗」）
                message: OVERFLOW,
                ...(opts.overflowFlag === false ? {} : { overflow: true as const }),
            };
            return;
        }
        yield { seq: 2, type: 'text.delta', messageId: `msg-${runs.length}`, delta: `reply-${runs.length}` };
        input.onStepTranscript?.([{ role: 'assistant', content: [{ type: 'text', text: `reply-${runs.length}` }] }]);
        yield {
            seq: 3,
            type: 'run.finished',
            turnId,
            finishReason: 'stop',
            steps: 1,
            maxOutputTokens: input.maxOutputTokens ?? 0,
        };
        yield { seq: 4, type: 'run.completed', turnId };
    } as (input: RunOptions) => AsyncIterable<AgentEvent>;

    const session = new BotSession({
        bot: BOT,
        modelKey: 'm',
        seed: () => SEED,
        windowTokens: 1_000_000,
        compactor: simpleCompactor,
        allocateTurn: (): Turn => ({ turn: ++turn, turnId: `turn-${turn}` }),
        run,
    });
    session.subscribe((event) => {
        events.push(event);
        if (event.type === 'item') items.push(event.item);
    });
    return { session, runs, items, events };
}

describe('超窗自愈', () => {
    it('第一次超窗 ⇒ 压一次并整轮重发，最终成功且用户看不到那句英文', async () => {
        const h = makeSession(1);
        await h.session.post({ messageId: 'm1', text: '继续干活' });

        // 真的重发了（同一 turn 跑了两次）
        expect(h.runs).toHaveLength(2);
        // 重发的那次历史更短（压缩生效了）
        expect(h.runs[1]!.length).toBeLessThan(h.runs[0]!.length);
        // 超窗那条错误**不进时间线**：整轮是成功的
        expect(h.items.some((item) => item.type === 'error')).toBe(false);
        const notice = h.items.find((item) => item.type === 'notice');
        expect(notice).toBeDefined();
        expect(JSON.stringify(notice)).toContain('context-overflow');
        // 收尾是正常完成，不是失败
        const end = h.events.find((event) => event.type === 'turn.end');
        expect(end !== undefined && end.type === 'turn.end' && end.result.failed).toBe(false);
    });

    it('两次都超 ⇒ 只重试一次，报中文结论', async () => {
        const h = makeSession(2);
        await h.session.post({ messageId: 'm1', text: '继续干活' });

        expect(h.runs).toHaveLength(2);
        const errors = h.items.filter((item) => item.type === 'error');
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors[0])).toContain('超过了模型窗口');
        expect(JSON.stringify(errors[0])).not.toContain('maximum context length');
        // 只重试了一次：第一次超窗、第二次也超 ⇒ 停手（不会无限转）
        expect(h.runs).toHaveLength(2);
    });

    it('没有 overflow 事实的 400 ⇒ 不压缩、不重试（别的 400 不该走这条路）', async () => {
        const h = makeSession(1, { overflowFlag: false });
        await h.session.post({ messageId: 'm1', text: '继续干活' });

        expect(h.runs).toHaveLength(1);
        expect(h.items.some((item) => item.type === 'error')).toBe(true);
    });
});

// progress.test.ts —— `progress` 事件的归约 + 显示文案（两套 surface 共用）。
//
// 锁四件事：
//   1. 归约：progress 事件按 botId 存、turn.end 清掉它、done 全清
//   2. 自走：本地流逝要加在服务端 idleMs 上（不每秒发事件、也不依赖服务端时钟）
//   3. 三档文案：quiet 与改造前一致、slow 说「等了多久没动」、stalled 说失联
//   4. 有心跳（alive）永不报警 —— 12 分钟的 bash 也要显示成「有进展 3s 前」

import { describe, expect, it } from 'vitest';

import {
    awaitingText,
    deliveryNoteOf,
    doingText,
    elapsedText,
    idleNowOf,
    progressLineOf,
    waitTextOf,
    type BotProgress,
} from '../src/progress';
import { applyEvent, emptyState } from '../src/reduce';
import type { StreamEvent } from '../src/types';

function progressEvent(overrides: Partial<Extract<StreamEvent, { kind: 'progress' }>> = {}): StreamEvent {
    return {
        kind: 'progress',
        botId: 'b1',
        turnId: 't1',
        awaiting: 'model-stream',
        idleMs: 0,
        alive: false,
        stage: 'quiet',
        ...overrides,
    };
}

function botProgress(overrides: Partial<BotProgress> = {}): BotProgress {
    return { awaiting: 'model-stream', idleMs: 0, at: 1_000_000, alive: false, stage: 'quiet', ...overrides };
}

describe('reduce：progress 事实', () => {
    it('按 botId 存进 state；不同成员互不覆盖', () => {
        let state = applyEvent(emptyState(), progressEvent({ botId: 'b1', idleMs: 3_000 }));
        state = applyEvent(state, progressEvent({ botId: 'b2', awaiting: 'tool:bash', idleMs: 60_000, stage: 'slow' }));

        expect(state.progress['b1']?.awaiting).toBe('model-stream');
        expect(state.progress['b1']?.idleMs).toBe(3_000);
        expect(state.progress['b2']?.awaiting).toBe('tool:bash');
        expect(state.progress['b2']?.stage).toBe('slow');
    });

    it('turn.end 清掉这个成员的进展（下一轮不该闪旧文案）', () => {
        let state = applyEvent(emptyState(), progressEvent({ botId: 'b1' }));
        state = applyEvent(state, {
            kind: 'turn.end',
            botId: 'b1',
            turnId: 't1',
            reason: { type: 'completed' },
        });
        expect(state.progress['b1']).toBeUndefined();
    });

    it('done（连接结束）全清', () => {
        let state = applyEvent(emptyState(), progressEvent({ botId: 'b1' }));
        state = applyEvent(state, { kind: 'done' });
        expect(state.progress).toEqual({});
    });
});

describe('progress：显示文案', () => {
    it('机器码 → 人话', () => {
        expect(awaitingText('model-stream')).toBe('模型响应');
        expect(awaitingText('tool:bash')).toBe('bash');
        expect(awaitingText('compact')).toBe('压缩上下文');
        expect(awaitingText('ask')).toBe('等回答');
        // 不认识的码原样给（宁可难看也不丢信息）
        expect(awaitingText('plugin:foo')).toBe('plugin:foo');
    });

    it('进行时短语：跑工具时不能说「正在说话」', () => {
        expect(doingText('model-stream')).toBe('正在等模型…');
        expect(doingText('tool:bash')).toBe('正在调用 bash…');
        expect(doingText('compact')).toBe('正在压缩上下文…');
    });

    it('秒数格式：短用 s、过分钟用 m 补零、过小时用 h', () => {
        expect(elapsedText(12_400)).toBe('12s');
        expect(elapsedText(63_000)).toBe('1m03s');
        expect(elapsedText(12 * 60_000)).toBe('12m00s');
        expect(elapsedText(3 * 3600_000 + 5 * 60_000)).toBe('3h05m');
    });

    it('自走：服务端 idleMs + 本地流逝', () => {
        const progress = botProgress({ idleMs: 5_000, at: 1_000_000 });
        expect(idleNowOf(progress, 1_003_000)).toBe(8_000);
    });

    it('quiet：只说在干什么，秒数交给右侧的「已用」（同一时长不说两遍）', () => {
        expect(progressLineOf(botProgress({ idleMs: 12_000 }), 1_000_000)).toBe('执行中');
    });

    it('slow：把秒数从「等了多久」换成「多久没动」', () => {
        const line = progressLineOf(botProgress({ idleMs: 63_000, stage: 'slow' }), 1_000_000);
        expect(line).toBe('等待模型响应 · 已 1m03s');
    });

    it('stalled：说失联（此时服务端已准备收掉这一轮）', () => {
        const line = progressLineOf(botProgress({ idleMs: 125_000, stage: 'stalled' }), 1_000_000);
        expect(line).toBe('失联 2m05s（等模型响应）');
    });

    it('alive：有心跳就永不报警（12 分钟的 bash 也健康）', () => {
        const line = progressLineOf(botProgress({ awaiting: 'tool:bash', idleMs: 3_000, alive: true }), 1_000_000);
        expect(line).toBe('bash 运行中 · 有进展 3s前');
        // 即使服务端已判 slow（工具静默很久），alive 仍优先 —— 它确实在吐东西
        const long = progressLineOf(
            botProgress({ awaiting: 'tool:bash', idleMs: 400_000, alive: true, stage: 'slow' }),
            1_000_000,
        );
        expect(long).toBe('bash 运行中 · 有进展 6m40s前');
    });
});

describe('waitTextOf —— 待答提问等了多久', () => {
    it('按服务端提问时刻算（刷新页面也照样说「已等 27m」）', () => {
        expect(waitTextOf(1_000_000 - 27 * 60_000, 1_000_000)).toBe('已等 27m00s');
    });

    it('刚发出几秒不说（噪音），缺时刻也不说', () => {
        expect(waitTextOf(1_000_000 - 1_500, 1_000_000)).toBe('');
        expect(waitTextOf(undefined, 1_000_000)).toBe('');
    });

    it('时钟漂移（at 在未来）不显示负数', () => {
        expect(waitTextOf(1_000_000 + 60_000, 1_000_000)).toBe('');
    });
});

describe('deliveryNoteOf —— 「发了没人理」的唯一可见信号', () => {
    const base = { state: 'pending' as const, updatedAt: 1_000_000 - 26 * 60_000, live: false, now: 1_000_000 };

    it('还没轮到：说「等着」+ 多久', () => {
        expect(deliveryNoteOf(base)).toBe('等着 26m00s');
    });

    it('正在处理（working）不说话 —— 那段时间由运行指示器管', () => {
        expect(deliveryNoteOf({ ...base, state: 'working' })).toBeUndefined();
    });

    it('bot 在动（live）就闭嘴 —— 那时行尾已有运行指示器，重复说会让人以为消息没发出去', () => {
        expect(deliveryNoteOf({ ...base, live: true })).toBeUndefined();
    });

    it('没到 15s 不说话（正常开跑就是毫秒级，短等待说出来只是噪音）', () => {
        expect(deliveryNoteOf({ ...base, updatedAt: 1_000_000 - 5_000 })).toBeUndefined();
    });

    it('已经处理完的不归它管（失败/成功各有各的显示）', () => {
        expect(deliveryNoteOf({ ...base, state: 'done' })).toBeUndefined();
    });
});

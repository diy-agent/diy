// progress.test.ts —— 卡死判据：假 clock + 脚本化事件流，不需要真等 120 秒。
//
// 锁五件事（对应计划 2026-11-24-long-task-deadline.md 第 6 节）：
//   1. 挂死：不吐字节 → 60s 只提示、120s abort（提示 ≠ 杀，先礼后兵）
//   2. 不误杀长工具：有心跳的 12 分钟 bash 永远不报警（demo 场景②）
//   3. 工具无心跳：300s 只提示、不 abort（工具可能合法长跑）
//   4. 正常说完不被干扰：持续吐字永不触发
//   5. 收尾后不再判 stall / warn 去重（每 5s 调一次不该刷屏）

import { describe, expect, it } from 'vitest';

import { DEFAULT_PROGRESS_POLICY, ProgressBroadcast, ProgressWatch, stageOf } from '../src/progress';
import { progressNotice } from '../src/end-reason';
import type { AgentEvent } from '../src/types';

/** 假时钟：`tick` 推进，`now` 给 ProgressWatch */
function clock(start = 1_000_000) {
    let at = start;
    return {
        now: () => at,
        tick: (ms: number) => {
            at += ms;
            return at;
        },
    };
}

function textDelta(seq: number, delta = 'x'): AgentEvent {
    return { seq, type: 'text.delta', messageId: 'msg-1', delta };
}

function toolStarted(seq: number, name = 'bash', toolCallId = 'call-1'): AgentEvent {
    return { seq, type: 'tool.started', turnId: 'turn-1', toolCallId, name, args: {} };
}

function toolCompleted(seq: number, name = 'bash', toolCallId = 'call-1'): AgentEvent {
    return { seq, type: 'tool.completed', turnId: 'turn-1', toolCallId, name, result: {} };
}

describe('progress：模型流挂死', () => {
    it('60s 只提示，120s 才 abort（先礼后兵）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(59_999);
        expect(watch.evaluate().action).toBe('wait');

        fake.tick(1);
        const first = watch.evaluate();
        expect(first.action).toBe('warn');
        if (first.action === 'warn') {
            expect(first.awaiting).toBe('model-stream');
            expect(first.note).toBe('no-first-byte');
        }

        // 提示过之后再涨也不重复提示
        fake.tick(30_000);
        expect(watch.evaluate().action).toBe('wait');

        // 120s：真的杀
        fake.tick(30_000);
        const kill = watch.evaluate();
        expect(kill.action).toBe('abort');
        if (kill.action === 'abort') {
            expect(kill.awaiting).toBe('model-stream');
            expect(kill.note).toBe('no-first-byte');
            expect(kill.idleMs).toBeGreaterThanOrEqual(DEFAULT_PROGRESS_POLICY.streamSilenceMs);
        }
    });

    it('流中静默：吐过字后停住，120s 判失联且 note=stream-silent', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(3_000);
        watch.apply(textDelta(1));
        expect(watch.evaluate().action).toBe('wait');

        // 吐过字 ⇒ 首字节提示不再适用
        fake.tick(59_000);
        expect(watch.evaluate().action).toBe('wait');

        fake.tick(61_000);
        const kill = watch.evaluate();
        expect(kill.action).toBe('abort');
        if (kill.action === 'abort') expect(kill.note).toBe('stream-silent');
    });

    it('正常说完不被干扰：持续吐字永不触发', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        for (let seq = 1; seq <= 40; seq += 1) {
            fake.tick(10_000);
            watch.apply(textDelta(seq));
            expect(watch.evaluate().action).toBe('wait');
        }
        // 跑满 400 秒也没有任何 warn / abort
    });
});

describe('progress：工具挂住', () => {
    it('有心跳的 12 分钟 bash 永不报警（demo 场景②）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(1_000);
        watch.apply(toolStarted(2));

        // 每 30s 一点输出心跳，跑满 12 分钟
        for (let i = 0; i < 24; i += 1) {
            fake.tick(30_000);
            watch.beat('tool:bash', 'tool-output');
            expect(watch.evaluate().action).toBe('wait');
        }
        const snapshot = watch.snapshot();
        expect(snapshot?.pending.at(-1)?.heartbeat?.from).toBe('tool-output');
    });

    it('无心跳：300s 只提示，绝不 abort', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        fake.tick(1_000);
        watch.apply(toolStarted(2));

        fake.tick(299_000);
        expect(watch.evaluate().action).toBe('wait');

        fake.tick(1_000);
        const warn = watch.evaluate();
        expect(warn.action).toBe('warn');
        if (warn.action === 'warn') {
            expect(warn.awaiting).toBe('tool:bash');
            expect(warn.note).toBe('tool-silent');
        }

        // 再久也不杀：只提示一次
        fake.tick(600_000);
        expect(watch.evaluate().action).toBe('wait');
    });

    it('tool.completed 之后回到等模型（不是空栈）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        fake.tick(1_000);
        watch.apply(toolStarted(2));
        fake.tick(1_000);
        watch.apply(toolCompleted(3));

        const pending = watch.snapshot()?.pending ?? [];
        expect(pending.map((item) => item.what)).toEqual(['model-stream']);

        // 回到等模型 ⇒ 流又静默 120s 才该杀（60s 起可能先给首字节提示，但不是 abort）
        fake.tick(119_000);
        expect(watch.evaluate().action).not.toBe('abort');
        fake.tick(1_000);
        expect(watch.evaluate().action).toBe('abort');
    });

    it('同名工具并发时按 toolCallId 拔对那一根', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        watch.apply(toolStarted(2, 'bash', 'call-a'));
        watch.apply(toolStarted(3, 'bash', 'call-b'));
        watch.apply(toolCompleted(4, 'bash', 'call-a'));

        const pending = watch.snapshot()?.pending ?? [];
        // call-a 被拔掉；call-b 还挂着；后面跟一根等模型的（工具回来了，下一步又等模型）
        expect(pending.map((item) => item.what)).toEqual(['tool:bash', 'model-stream']);
        expect(pending[0]?.ref).toBe('call-b');
    });
});

describe('progress：只提示不杀的项', () => {
    it('整轮墙钟 30 分钟只提示', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        // 每 60s 吐一次字（一直在动），墙钟 30 分钟
        for (let i = 0; i < 30; i += 1) {
            fake.tick(60_000);
            watch.apply(textDelta(i + 1));
        }
        const verdict = watch.evaluate();
        expect(verdict.action).toBe('warn');
        if (verdict.action === 'warn') expect(verdict.note).toBe('turn-wall');
    });

    it('压缩慢只提示', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        watch.enter('compact');
        fake.tick(300_000);
        const verdict = watch.evaluate();
        expect(verdict.action).toBe('warn');
        if (verdict.action === 'warn') expect(verdict.awaiting).toBe('compact');
    });
});

describe('progress：收尾', () => {
    it('run.finished 之后不再判 stall（收尾判据归 end-reason）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        watch.apply({ seq: 2, type: 'run.finished', turnId: 'turn-1', finishReason: 'stop', steps: 1, maxOutputTokens: 8000, maxSteps: 200 });
        fake.tick(600_000);
        expect(watch.evaluate().action).toBe('wait');
        expect(watch.stall()).toBeUndefined();
    });

    it('stall() 报的是"等谁 + 空多久"，不看阈值', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        fake.tick(5_000);
        watch.apply(toolStarted(2));
        fake.tick(7_000);
        expect(watch.stall()).toEqual({ awaiting: 'tool:bash', idleMs: 7_000 });
    });

    it('reset 后不再产出结论；未 start 时 evaluate 安全', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        expect(watch.evaluate().action).toBe('wait');
        watch.start('turn-1');
        watch.reset();
        fake.tick(600_000);
        expect(watch.evaluate().action).toBe('wait');
    });

    it('阈值可覆盖（每 bot 可配）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now, policy: { firstByteMs: 10, streamSilenceMs: 20 } });
        watch.start('turn-1');
        fake.tick(10);
        expect(watch.evaluate().action).toBe('warn');
        fake.tick(10);
        expect(watch.evaluate().action).toBe('abort');
    });
});

describe('progress：对外事实（progress 事件的内容）', () => {
    it('fact：工具有心跳时 idleMs 从心跳算（不是从挂上那一刻）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        fake.tick(1_000);
        watch.apply(toolStarted(2));
        fake.tick(29_000);
        watch.beat('tool:bash', 'tool-output'); // 30s 时吐了一行
        fake.tick(3_000);
        expect(watch.fact()).toEqual({ awaiting: 'tool:bash', idleMs: 3_000, alive: true });
    });

    it('fact 报 awaiting / idleMs / alive；未 start 或已收尾时为 undefined', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        expect(watch.fact()).toBeUndefined();

        watch.start('turn-1');
        fake.tick(5_000);
        expect(watch.fact()).toEqual({ awaiting: 'model-stream', idleMs: 5_000, alive: false });

        // 吐过字 = 有活的证据
        watch.apply(textDelta(1));
        expect(watch.fact()?.alive).toBe(true);
        expect(watch.fact()?.idleMs).toBe(0);

        // 收尾中（pending 已清）不报事实，UI 不该再显示「在执行」
        watch.apply({
            seq: 2,
            type: 'run.finished',
            turnId: 'turn-1',
            finishReason: 'stop',
            steps: 1,
            maxOutputTokens: 8000,
            maxSteps: 200,
        });
        expect(watch.fact()).toBeUndefined();
    });

    it('stageOf 分档：模型流 60s 进 slow、120s 进 stalled；工具只到 slow', () => {
        expect(stageOf({ awaiting: 'model-stream', idleMs: 59_999 })).toBe('quiet');
        expect(stageOf({ awaiting: 'model-stream', idleMs: 60_000 })).toBe('slow');
        expect(stageOf({ awaiting: 'model-stream', idleMs: 120_000 })).toBe('stalled');
        // 工具可能合法长跑 12 分钟：过了阈值也只提示，不报 stalled
        expect(stageOf({ awaiting: 'tool:bash', idleMs: 119_000 })).toBe('quiet');
        expect(stageOf({ awaiting: 'tool:bash', idleMs: 300_000 })).toBe('slow');
    });

    it('ProgressBroadcast：事实没变不发（否则每 5s 一次整壳重渲）', () => {
        const broadcast = new ProgressBroadcast();
        // 第一条：前 60s 完全安静也要先让 UI 知道「在等模型」
        expect(broadcast.shouldSend({ awaiting: 'model-stream', idleMs: 0, alive: false })).toBe('quiet');
        // 只是 idleMs 在涨：不发（null），客户端自走
        expect(broadcast.shouldSend({ awaiting: 'model-stream', idleMs: 5_000, alive: false })).toBeNull();
        // 跨档：值得说一句，且带上新档位（UI 不再自己比秒数）
        expect(broadcast.shouldSend({ awaiting: 'model-stream', idleMs: 60_000, alive: false })).toBe('slow');
        // 心跳翻转
        expect(broadcast.shouldSend({ awaiting: 'model-stream', idleMs: 0, alive: true })).toBe('quiet');
        // 换了一个 await
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 0, alive: false })).toBe('quiet');
    });

    it('有心跳时最多每 5s 刷新一次基准（否则「有进展 Ns 前」会跟着本地时钟涨）', () => {
        const broadcast = new ProgressBroadcast();
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 0, alive: true }, 0)).toBe('quiet');
        // 3s 后：不到刷新周期，不发
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 3_000, alive: true }, 3_000)).toBeNull();
        // 5s 后：刷新一条（idleMs 被重置到 1s）
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 1_000, alive: true }, 5_000)).toBe('quiet');
        // 心跳停了（alive 翻转）也要发，之后就不再刷新
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 6_000, alive: false }, 6_000)).not.toBeNull();
        expect(broadcast.shouldSend({ awaiting: 'tool:bash', idleMs: 11_000, alive: false }, 11_000)).toBeNull();
    });
});

describe('progress：提醒条目（warn → notice，刷新后还在）', () => {
    const ctx = { turn: 3, turnId: 'turn-1', at: 123 };

    it('首字节慢：说清「等了多久」与「再等就中止」', () => {
        const item = progressNotice({ awaiting: 'model-stream', idleMs: 60_000, note: 'no-first-byte' }, ctx);
        expect(item.type).toBe('notice');
        expect(item.turn).toBe(3);
        expect(item.turnId).toBe('turn-1');
        if (item.type === 'notice') {
            expect(item.data.kind).toBe('progress:no-first-byte');
            expect(item.data.text).toContain('60 秒');
            expect(item.data.text).toContain('第一个字');
            expect(item.data.text).toContain('中止');
        }
    });

    it('工具静默：点明「不会被中止」（免得人以为卡死了）', () => {
        const item = progressNotice({ awaiting: 'tool:bash', idleMs: 300_000, note: 'tool-silent' }, ctx);
        if (item.type === 'notice') {
            expect(item.data.kind).toBe('progress:tool-silent');
            expect(item.data.text).toContain('bash');
            expect(item.data.text).toContain('不会被中止');
        }
    });
});

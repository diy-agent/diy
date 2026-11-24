// progress.test.ts —— 卡死判据：假 clock + 脚本化事件流，不需要真等 120 秒。
//
// 锁五件事（对应计划 2026-11-24-long-task-deadline.md 第 6 节 + 2026-11-25 的「一个 await 一个所有者」）：
//   1. 挂死：**只报档位、从不 abort** —— 中止权在 agent 层的 StallWatchdog
//   2. 档位必然**早于**斩杀线（派生关系），否则 UI 那一档永远看不到
//   3. 不误杀长工具：有心跳的 12 分钟 bash 永远停在 quiet（demo 场景②）
//   4. 工具无心跳 / compact：只到 slow 档
//   5. **过程不落库**（用户 2026-11-24）：这里只验事实与档位，不再有任何 notice 条目
//      —— `evaluate()` / `ProgressVerdict` / `progressNotice` 已删，判据只剩 `fact()` + `stageOf()`

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PROGRESS_POLICY,
    ProgressBroadcast,
    ProgressWatch,
    progressPolicyFromStall,
    stageOf,
} from '../src/progress';
import { DEFAULT_STALL } from '../src/stall-watchdog';
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

/** 此刻的档位（= UI 会显示的那一档；`none` = 没有挂着的事实，比如已收尾）。
 * 走 `watch.stage()` 而不是 `stageOf(watch.fact())`：后者用默认 policy，测试里覆盖的阈值会失灵。 */
function stage(watch: ProgressWatch): string {
    return watch.stage() ?? 'none';
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
    it('60s 进 slow、120s 进 stalled，**到 240s 也不自己动手**（杀归 StallWatchdog）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(59_999);
        expect(stage(watch)).toBe('quiet');

        fake.tick(1);
        expect(stage(watch)).toBe('slow');

        // 120s：UI 报 stalled 档（这是让人看见的最后一档，杀在 180s 且不在这里）
        fake.tick(60_000);
        expect(stage(watch)).toBe('stalled');

        // 走过 StallWatchdog 的斩杀线：事实仍在、档位不降 —— 本文件从头到尾没有 abort 这个结论
        fake.tick(120_000);
        expect(stage(watch)).toBe('stalled');
    });

    it('流中静默：吐过字后停住，40s 进 slow、80s 进 stalled', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(3_000);
        watch.apply(textDelta(1));
        expect(stage(watch)).toBe('quiet');

        // 吐过字之后用「流中」那一组，**不是**首包那组的 60s：39s 还不叫
        fake.tick(39_999);
        expect(stage(watch)).toBe('quiet');

        // 40s（= 斩杀线 120s 的 1/3）进 slow
        fake.tick(1);
        expect(stage(watch)).toBe('slow');

        // 80s（= 120s 的 2/3）进 stalled；120s 才由 StallWatchdog 杀
        fake.tick(40_000);
        expect(stage(watch)).toBe('stalled');
    });

    it('档位必然早于斩杀线（否则 UI 那一档提示窗口为零）', () => {
        const p = DEFAULT_PROGRESS_POLICY;
        expect(p.firstByteWarnMs).toBeLessThan(p.firstByteStalledMs);
        expect(p.firstByteStalledMs).toBeLessThan(DEFAULT_STALL.firstMs);
        expect(p.streamWarnMs).toBeLessThan(p.streamStalledMs);
        expect(p.streamStalledMs).toBeLessThan(DEFAULT_STALL.idleMs);
        // 数值与默认斩杀线对得上（180s → 60s / 120s；120s → 40s / 80s）
        expect(p.firstByteWarnMs).toBe(60_000);
        expect(p.firstByteStalledMs).toBe(120_000);
        expect(p.streamWarnMs).toBe(40_000);
        expect(p.streamStalledMs).toBe(80_000);
    });

    it('斩杀线关了（env 设 0）时档位永远 quiet：不会空报警', () => {
        const p = progressPolicyFromStall({ firstMs: 0, idleMs: 0 });
        expect(p.streamWarnMs).toBe(Number.POSITIVE_INFINITY);
        expect(p.firstByteStalledMs).toBe(Number.POSITIVE_INFINITY);
        const policy = { ...DEFAULT_PROGRESS_POLICY, ...p };
        expect(stageOf({ awaiting: 'model-stream', idleMs: 10 ** 9 }, policy)).toBe('quiet');
    });

    it('正常说完不被干扰：持续吐字永远停在 quiet', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        for (let seq = 1; seq <= 40; seq += 1) {
            fake.tick(10_000);
            watch.apply(textDelta(seq));
            expect(stage(watch)).toBe('quiet');
        }
    });
});

describe('progress：工具挂住', () => {
    it('有心跳的 12 分钟 bash 永远 quiet（demo 场景②）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');

        fake.tick(1_000);
        watch.apply(toolStarted(2));

        // 每 30s 一点输出心跳，跑满 12 分钟
        for (let i = 0; i < 24; i += 1) {
            fake.tick(30_000);
            watch.beat('tool:bash', 'tool-output');
            expect(stage(watch)).toBe('quiet');
        }
        const snapshot = watch.snapshot();
        expect(snapshot?.pending.at(-1)?.heartbeat?.from).toBe('tool-output');
    });

    it('无心跳：300s 只进 slow，再久也不报 stalled（工具可能合法长跑）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        fake.tick(1_000);
        watch.apply(toolStarted(2));

        fake.tick(299_000);
        expect(stage(watch)).toBe('quiet');

        fake.tick(1_000);
        expect(stage(watch)).toBe('slow');

        // 再久也停在 slow：工具档不设 stalled（本层永远不杀）
        fake.tick(600_000);
        expect(stage(watch)).toBe('slow');
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

        // 回到等模型 ⇒ 又按模型流的档位判（本文件**永远不会 abort**，杀在 StallWatchdog）
        fake.tick(59_999);
        expect(stage(watch)).toBe('quiet');
        fake.tick(1);
        expect(stage(watch)).toBe('slow');
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

    it('压缩慢只进 slow 档', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        watch.enter('compact');
        fake.tick(300_000);
        expect(stage(watch)).toBe('slow');
        expect(watch.fact()?.awaiting).toBe('compact');
    });
});

describe('progress：收尾', () => {
    it('run.finished 之后不再有任何事实（收尾判据归 end-reason）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        watch.start('turn-1');
        watch.apply({
            seq: 2,
            type: 'run.finished',
            turnId: 'turn-1',
            finishReason: 'stop',
            steps: 1,
            maxOutputTokens: 8000,
            maxSteps: 200,
        });
        fake.tick(600_000);
        expect(stage(watch)).toBe('none');
    });

    it('reset / 未 start 时没有事实（不会误报）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        expect(stage(watch)).toBe('none');
        watch.start('turn-1');
        watch.reset();
        fake.tick(600_000);
        expect(stage(watch)).toBe('none');
    });

    it('阈值可覆盖（每 bot 可配）', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now, policy: { firstByteWarnMs: 10 } });
        watch.start('turn-1');
        fake.tick(10);
        expect(stage(watch)).toBe('slow');
        // 覆盖之后依然只报档位、不杀（也不落库）
        fake.tick(10 ** 6);
        expect(stage(watch)).not.toBe('none');
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
        expect(watch.fact()).toEqual({ awaiting: 'tool:bash', idleMs: 3_000, alive: true, sawContent: false });
    });

    it('fact 报 awaiting / idleMs / alive；未 start 或已收尾时为 undefined', () => {
        const fake = clock();
        const watch = new ProgressWatch({ now: fake.now });
        expect(watch.fact()).toBeUndefined();

        watch.start('turn-1');
        fake.tick(5_000);
        expect(watch.fact()).toEqual({ awaiting: 'model-stream', idleMs: 5_000, alive: false, sawContent: false });

        // 吐过字 = 有活的证据
        watch.apply(textDelta(1));
        expect(watch.fact()?.alive).toBe(true);
        expect(watch.fact()?.idleMs).toBe(0);
        expect(watch.fact()?.sawContent).toBe(true);

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
        // 工具可能合法长跑 12 分钟：过了阈值也只到 slow，不报 stalled
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

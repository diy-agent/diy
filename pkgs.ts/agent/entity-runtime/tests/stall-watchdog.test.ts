// stall-watchdog.test.ts —— 上游停摆判定。
//
// 为什么值得单测：这个计时器决定「一轮会不会有个结局」。判错的两种方式都很难在集成测试里
// 复现（要一个真会挂住的网关）：**该掐不掐**（永远卡住，2026-11-23 实测事故）与
// **不该掐乱掐**（`job wait` / `ask` 这种合法长等待被误杀）。

import { describe, expect, it } from 'vitest';

import { DEFAULT_STALL, StallWatchdog, stallMessage, stallTimeoutsFromEnv, type StallInfo } from '../src/stall-watchdog';

/** 手动时钟：只测判据，不睡真时间（无需 fake timers，也不怕 --no-isolate 串味） */
function fakeClock() {
    let now = 0;
    let nextHandle = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
        now: () => now,
        setTimer: (fn: () => void, ms: number) => {
            const handle = ++nextHandle;
            timers.set(handle, { at: now + ms, fn });
            return handle;
        },
        clearTimer: (handle: unknown) => {
            timers.delete(handle as number);
        },
        /** 推进时间：到点的定时器按顺序触发 */
        advance(ms: number) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
                const first = due[0];
                if (first === undefined) break;
                timers.delete(first[0]);
                now = first[1].at;
                first[1].fn();
            }
            now = target;
        },
        live: () => timers.size,
    };
}

function watchdogOf(clock: ReturnType<typeof fakeClock>, overrides: Partial<{ firstMs: number; idleMs: number; toolMs: number }> = {}) {
    const stalls: StallInfo[] = [];
    const watchdog = new StallWatchdog({
        firstMs: 100,
        idleMs: 50,
        toolMs: 0,
        ...overrides,
        onStall: (info) => stalls.push(info),
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    return { watchdog, stalls };
}

describe('首包超时', () => {
    it('一直没有数据 ⇒ 按 first 判停摆', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        clock.advance(99);
        expect(stalls).toEqual([]);
        clock.advance(1);
        expect(stalls).toEqual([{ phase: 'first', waitedMs: 100 }]);
    });

    it('第一个数据块到了就转成“块间隔”计时（不再按 3 分钟算首包）', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        clock.advance(90);
        watchdog.touch();
        clock.advance(49);
        expect(stalls).toEqual([]);
        clock.advance(1);
        expect(stalls).toEqual([{ phase: 'stream', waitedMs: 50 }]);
    });

    it('持续有数据就永不触发', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        for (let i = 0; i < 100; i += 1) {
            clock.advance(20);
            watchdog.touch();
        }
        expect(stalls).toEqual([]);
    });
});

describe('工具执行期', () => {
    it('缺省不设上限：`job wait` 等 10 分钟、`ask` 等用户都不算停摆', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        watchdog.touch();
        watchdog.toolStart();
        clock.advance(10 * 60 * 1000);
        expect(stalls).toEqual([]);
        expect(clock.live()).toBe(0); // 也不留一个悬着的定时器
    });

    it('显式给了 toolMs 就按它算', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock, { toolMs: 30 });
        watchdog.start();
        watchdog.toolStart();
        clock.advance(30);
        expect(stalls).toEqual([{ phase: 'tool', waitedMs: 30 }]);
    });

    it('工具结果回来 ⇒ 回到块间隔计时', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        watchdog.toolStart();
        watchdog.touch();
        clock.advance(50);
        expect(stalls).toEqual([{ phase: 'stream', waitedMs: 50 }]);
    });
});

describe('关掉与收尾', () => {
    it('时长 0 = 那一段不设上限', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock, { firstMs: 0, idleMs: 0 });
        watchdog.start();
        clock.advance(10 * 60 * 1000);
        expect(stalls).toEqual([]);
    });

    it('stop 之后不再触发（下一轮不该被上一轮的定时器掐）', () => {
        const clock = fakeClock();
        const { watchdog, stalls } = watchdogOf(clock);
        watchdog.start();
        watchdog.stop();
        clock.advance(1000);
        expect(stalls).toEqual([]);
        expect(clock.live()).toBe(0);
    });
});

describe('环境变量', () => {
    it('缺省值', () => {
        expect(stallTimeoutsFromEnv({})).toEqual(DEFAULT_STALL);
    });

    it('能改，0 = 关掉，非法值退回缺省', () => {
        expect(
            stallTimeoutsFromEnv({
                DIY2_LLM_STALL_FIRST_MS: '10',
                DIY2_LLM_STALL_IDLE_MS: '0',
                DIY2_LLM_STALL_TOOL_MS: 'oops',
            }),
        ).toEqual({ firstMs: 10, idleMs: 0, toolMs: DEFAULT_STALL.toolMs });
    });
});

describe('停滞文案', () => {
    it('说清是超时判定、不是用户操作', () => {
        const text = stallMessage({ phase: 'stream', waitedMs: 120_000 });
        expect(text).toContain('上游停摆');
        expect(text).toContain('120s');
        expect(text).toContain('不是你的操作问题');
    });
});

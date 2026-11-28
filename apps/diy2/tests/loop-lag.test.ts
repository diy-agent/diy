// loop-lag.test.ts —— 事件循环延迟监控与同步重活打点。
//
// 这两个工具是为了回答用户 2026-11-26 的「页面很慢」：最轻的 /api/info p90 也有 2.3s，
// 说明事件循环被卡住而进程自己毫无感觉。测试盯住三件不该走样的事：
//   · 慢才记（不慢不能刷屏，否则日志变成噪音）
//   · 每个窗口 reset（一次历史卡顿不能永远报警）
//   · stop 之后不再采样（关进程 / 重建不泄漏采样器）

import { describe, expect, it } from 'vitest';

import { configureSlowLog, startLoopLag, timed, timedAsync } from '../server/loop-lag';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('timed / timedAsync', () => {
    it('超过阈值才记一行；不慢的不记', () => {
        const lines: string[] = [];
        configureSlowLog((line) => lines.push(line));
        try {
            timed('fast', () => 1, 50);
            expect(lines).toEqual([]); // 快的不许留痕
            timed(
                'slow',
                () => {
                    const until = Date.now() + 60;
                    while (Date.now() < until) {
                        /* 占住 60ms，越过阈值 */
                    }
                },
                50,
            );
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain('slow');
            expect(lines[0]).toContain('ms');
        } finally {
            configureSlowLog((line) => console.warn(line));
        }
    });

    it('抛错时也计时（finally），且把错误原样抛出', () => {
        const lines: string[] = [];
        configureSlowLog((line) => lines.push(line));
        try {
            expect(() =>
                timed(
                    'boom',
                    () => {
                        const until = Date.now() + 60;
                        while (Date.now() < until) {
                            /* */
                        }
                        throw new Error('x');
                    },
                    50,
                ),
            ).toThrow('x');
            expect(lines[0]).toContain('boom');
        } finally {
            configureSlowLog((line) => console.warn(line));
        }
    });

    it('timedAsync 同样只记慢的', async () => {
        const lines: string[] = [];
        configureSlowLog((line) => lines.push(line));
        try {
            await timedAsync('quick', async () => 7, 50);
            expect(lines).toEqual([]);
            await timedAsync('awaiting', async () => sleep(60), 50);
            expect(lines[0]).toContain('awaiting');
        } finally {
            configureSlowLog((line) => console.warn(line));
        }
    });
});

describe('startLoopLag', () => {
    it('卡住多久就记多久（自己测 tick 间隔，不是被 resolution 封顶的内置直方图）', async () => {
        const seen: number[] = [];
        const monitor = startLoopLag({
            tickMs: 50,
            ticksPerWindow: 1,
            warnMs: 10_000, // 别触发 warn，只看 onSample
            onSample: (snapshot) => seen.push(snapshot.max),
            log: () => undefined,
        });
        try {
            // 卡住 200ms：期间 tick 跑不了，醒来那一跳会算出 ≥150ms 的 lag
            const until = Date.now() + 200;
            while (Date.now() < until) {
                /* 占住事件循环 */
            }
            await sleep(160);
            expect(Math.max(...seen)).toBeGreaterThanOrEqual(150);
        } finally {
            monitor.stop();
        }
    });

    it('卡顿行带 cpuRatio / load1，快照带机器状态（回答「自己卡还是被饿死」）', async () => {
        const lines: string[] = [];
        let last: { cpuRatio: number; system: { cpus: number; load1: number } } | undefined;
        const monitor = startLoopLag({
            tickMs: 50,
            ticksPerWindow: 1,
            warnMs: 10,
            onSample: (s) => {
                last = { cpuRatio: s.cpuRatio, system: s.system };
            },
            log: (line) => lines.push(line),
        });
        try {
            const until = Date.now() + 120;
            while (Date.now() < until) {
                /* 占住事件循环，并真的烧 CPU */
            }
            // 机器忙时定时器可能被饿一会儿，最多等 2s 拿那个「醒来」的 tick
            for (let i = 0; i < 40 && last === undefined; i += 1) await sleep(50);
            const lagLine = lines.find((line) => line.includes('[diy2:lag]'));
            expect(lagLine).toContain('cpuRatio=');
            expect(lagLine).toContain('load1=');
            expect(lagLine).toContain('ncpu=');
            expect(last?.cpuRatio).toBeGreaterThanOrEqual(0);
            expect(last?.cpuRatio).toBeLessThanOrEqual(1);
            expect(last?.system.cpus).toBeGreaterThanOrEqual(1);
        } finally {
            monitor.stop();
        }
    });

    it('stop 之后不再采样', async () => {
        const seen: number[] = [];
        const monitor = startLoopLag({
            tickMs: 30,
            ticksPerWindow: 1,
            onSample: (s) => seen.push(s.max),
            log: () => undefined,
        });
        monitor.stop();
        await sleep(90);
        expect(seen).toEqual([]);
    });

    it('卡顿只算它发生的那个窗口，之后的窗口回到 0', async () => {
        const seen: number[] = [];
        const monitor = startLoopLag({
            tickMs: 50,
            ticksPerWindow: 3,
            warnMs: 10_000,
            onSample: (s) => seen.push(s.max),
            log: () => undefined,
        });
        try {
            const until = Date.now() + 250; // 一次性卡 250ms（落在第一窗）
            while (Date.now() < until) {
                /* */
            }
            await sleep(500); // 再跨 3~4 个窗口
            expect(seen.length).toBeGreaterThanOrEqual(2);
            expect(seen[0]).toBeGreaterThanOrEqual(150);
            // 后面的窗口不该重复报同一次卡顿（否则历史卡顿会永远报警）
            expect(seen[seen.length - 1]).toBeLessThan(100);
        } finally {
            monitor.stop();
        }
    });
});

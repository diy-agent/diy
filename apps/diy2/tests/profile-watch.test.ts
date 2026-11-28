// profile-watch.test.ts —— 卡顿归因：有 lag 才落 `.cpuprofile`，没 lag 不留垃圾。
//
// 盯住三件事：
//   · 卡顿那一段的 profile 真的落盘，且是 DevTools 能读的结构（nodes / samples）
//   · 没报卡就不写文件（常开采样器不能变成磁盘噪音）
//   · stop 之后不再写、不抛

import { describe, expect, it } from 'vitest';

import { profileStamp, startCpuProfileWatch } from '../server/profile-watch';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Written {
    path: string;
    data: string;
}

describe('startCpuProfileWatch', () => {
    it('报过卡才落盘，且文件是合法的 cpuprofile', async () => {
        const writes: Written[] = [];
        const watch = startCpuProfileWatch({
            dir: '/tmp/diy2-profile-test',
            rotateMs: 40,
            samplingIntervalUs: 1000,
            log: () => undefined,
            writeFile: async (path, data) => {
                writes.push({ path, data });
            },
        });
        try {
            // 先烧一点 CPU，确保采样里能拿到帧
            const until = Date.now() + 60;
            while (Date.now() < until) {
                /* */
            }
            watch.markLag(60);
            // 轮转周期 40ms；冷启动时 Inspector 的 enable/start 可能要几百 ms，最多等 2s
            for (let i = 0; i < 40 && writes.length === 0; i += 1) await sleep(50);
            expect(writes.length).toBeGreaterThan(0);
            const first = writes[0];
            expect(first?.path).toMatch(/cpu-.+\.cpuprofile$/);
            const profile = JSON.parse(first?.data ?? '{}') as { nodes?: unknown[]; samples?: number[] };
            expect(Array.isArray(profile.nodes)).toBe(true);
            expect(profile.samples?.length ?? 0).toBeGreaterThan(0);
        } finally {
            await watch.stop();
        }
    });

    it('后面更长的饥饿卡顿不会盖掉前面 CPU 卡顿的 profile', async () => {
        const writes: Written[] = [];
        const watch = startCpuProfileWatch({
            dir: '/tmp/diy2-profile-test',
            rotateMs: 40,
            log: () => undefined,
            writeFile: async (path, data) => {
                writes.push({ path, data });
            },
        });
        try {
            const until = Date.now() + 60;
            while (Date.now() < until) {
                /* 先烧出样本 */
            }
            watch.markLag(500, 0.9); // 自己在算
            watch.markLag(5000, 0.1); // 随后机器把进程饿死，且数字更大
            for (let i = 0; i < 40 && writes.length === 0; i += 1) await sleep(50);
            expect(writes.length).toBeGreaterThan(0);
        } finally {
            await watch.stop();
        }
    });

    it('cpuRatio 低（被系统饿死）不落盘 —— profile 里只会是空闲栈', async () => {
        const writes: Written[] = [];
        const logs: string[] = [];
        const watch = startCpuProfileWatch({
            dir: '/tmp/diy2-profile-test',
            rotateMs: 30,
            log: (line) => logs.push(line),
            writeFile: async (path, data) => {
                writes.push({ path, data });
            },
        });
        try {
            watch.markLag(5000, 0.05);
            await sleep(120);
            expect(writes).toEqual([]);
            expect(logs.some((line) => line.includes('不写 profile'))).toBe(true);
        } finally {
            await watch.stop();
        }
    });

    it('没报卡就不写文件', async () => {
        const writes: Written[] = [];
        const watch = startCpuProfileWatch({
            dir: '/tmp/diy2-profile-test',
            rotateMs: 30,
            log: () => undefined,
            writeFile: async (path, data) => {
                writes.push({ path, data });
            },
        });
        await sleep(120);
        await watch.stop();
        expect(writes).toEqual([]);
    });

    it('stop 之后不再落盘', async () => {
        const writes: Written[] = [];
        const watch = startCpuProfileWatch({
            dir: '/tmp/diy2-profile-test',
            rotateMs: 30,
            log: () => undefined,
            writeFile: async (path, data) => {
                writes.push({ path, data });
            },
        });
        await sleep(60); // 等 profiler 就绪
        await watch.stop();
        watch.markLag(5000);
        await sleep(100);
        expect(writes).toEqual([]);
    });
});

describe('profileStamp', () => {
    it('可做文件名：本地时区、无冒号', () => {
        const stamp = profileStamp(new Date(2026, 10, 28, 11, 30, 0, 123).getTime());
        expect(stamp).toContain('2026-11-28T11-30-00');
        expect(stamp).not.toContain(':');
    });
});

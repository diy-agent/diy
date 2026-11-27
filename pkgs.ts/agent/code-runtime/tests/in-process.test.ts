import { describe, expect, it } from 'vitest';

import { InProcessVmRuntime } from '../src/in-process.js';
import { DEFAULT_LIMITS } from '../src/types.js';

const runtime = new InProcessVmRuntime();

describe('InProcessVmRuntime', () => {
    it('跑代码体并回值（可以直接 return / await）', async () => {
        const r = await runtime.run('const x = await Promise.resolve(2); return x + 3;', {
            timeoutMs: 1000,
            globals: {},
        });
        expect(r.outcome).toBe('ok');
        expect(r.value).toBe(5);
    });

    it('注入的 globals 能直接当全局用', async () => {
        const r = await runtime.run('return math.add(2, 3);', {
            timeoutMs: 1000,
            globals: { math: { add: (a: number, b: number) => a + b } },
        });
        expect(r.value).toBe(5);
    });

    it('同步死循环被 vm 的 timeout 杀掉（这条是选 vm 而不是 eval 的唯一理由）', async () => {
        const r = await runtime.run('while (true) {}', { timeoutMs: 50, globals: {} });
        expect(r.outcome).toBe('timeout');
    });

    it('await 之后的事件循环不挂（race 能收）', async () => {
        const r = await runtime.run('return await new Promise((r) => setTimeout(() => r("done"), 10));', {
            timeoutMs: 1000,
            globals: {},
        });
        expect(r.value).toBe('done');
    });

    it('await 永不 resolve 时按 timeout 收场', async () => {
        const r = await runtime.run('await new Promise(() => {});', { timeoutMs: 50, globals: {} });
        expect(r.outcome).toBe('timeout');
    });

    it('abort 信号优先于完成', async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 20);
        const r = await runtime.run('await new Promise((r) => setTimeout(r, 500));', {
            timeoutMs: 1000,
            signal: ac.signal,
            globals: {},
        });
        expect(r.outcome).toBe('aborted');
    });

    it('console 输出被收集，超预算后截断并留说明', async () => {
        const small = new InProcessVmRuntime({ ...DEFAULT_LIMITS, logBytes: 100, logChars: 100 });
        const r = await small.run('for (let i = 0; i < 100; i++) console.log("line " + i);', {
            timeoutMs: 1000,
            globals: {},
        });
        expect(r.truncated).toBe(true);
        expect(r.logs.at(-1)?.text).toContain('预算');
    });

    it('不可序列化的返回值给占位串，不抛', async () => {
        const r = await runtime.run('return () => 1;', { timeoutMs: 1000, globals: {} });
        expect(r.value).toBe('[unserializable: function]');
    });

    it('循环引用不炸，给占位串', async () => {
        const r = await runtime.run('const a = {}; a.self = a; return a;', { timeoutMs: 1000, globals: {} });
        expect(String(r.value)).toContain('[unserializable: object]');
    });

    it('代码里抛错按 error 收场，且带 message', async () => {
        const r = await runtime.run('throw new Error("boom");', { timeoutMs: 1000, globals: {} });
        expect(r.outcome).toBe('error');
        expect(String(r.value)).toContain('boom');
    });

    it('globals 里没有 process / require', async () => {
        const r = await runtime.run('return { hasProcess: typeof process, hasRequire: typeof require };', {
            timeoutMs: 1000,
            globals: {},
        });
        expect(r.value).toEqual({ hasProcess: 'undefined', hasRequire: 'undefined' });
    });
});

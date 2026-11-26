import { describe, expect, it } from 'vitest';

import { InProcessVmRuntime } from '../src/in-process.js';
import { formatApiHelp, makeGlobals, type ApiHelpItem } from '../src/globals.js';

const runtime = new InProcessVmRuntime();

describe('makeGlobals', () => {
    it('键集合稳定（换引擎时不能变）', () => {
        const g = makeGlobals({ api: {} });
        expect(Object.keys(g).sort()).toEqual(
            [
                'JSON',
                'Date',
                'Math',
                'TextDecoder',
                'TextEncoder',
                'URL',
                'URLSearchParams',
                'api',
                'clone',
                'fetch',
                'now',
                'sleep',
            ].sort(),
        );
    });

    it('给了 apiHelp 才多一个键，且是函数（懒生成）', () => {
        const items: ApiHelpItem[] = [{ path: 'diy2.bots.list', desc: '列 bot', mode: 'unary' }];
        const g = makeGlobals({ api: {}, apiHelp: items });
        expect(typeof g['apiHelp']).toBe('function');
        expect((g['apiHelp'] as () => readonly ApiHelpItem[])()).toEqual(items);
    });

    it('sleep 受 signal 约束：abort 后 reject', async () => {
        const ac = new AbortController();
        const g = makeGlobals({ api: {}, signal: ac.signal });
        const sleep = g['sleep'] as (ms: number) => Promise<void>;
        const p = sleep(5_000);
        ac.abort();
        await expect(p).rejects.toThrow('aborted');
    });

    it('clone 防入参别名（模型改动不回流到调用方）', () => {
        const g = makeGlobals({ api: {} });
        const source = { a: { b: 1 } };
        const copy = (g['clone'] as <T>(v: T) => T)(source);
        copy.a.b = 2;
        expect(source.a.b).toBe(1);
    });

    it('端到端：模型代码里 api / sleep / apiHelp 都能直接用', async () => {
        const calls: string[] = [];
        const api = { bots: { list: async (): Promise<string[]> => ['a', 'b'] } };
        const g = makeGlobals({
            api: {
                bots: {
                    list: async (): Promise<string[]> => {
                        calls.push('bots.list');
                        return api.bots.list();
                    },
                },
            },
            apiHelp: [{ path: 'diy2.bots.list', desc: '列 bot', mode: 'unary' }],
        });
        const r = await runtime.run(
            [
                'const help = apiHelp();',
                'const bots = await api.bots.list({});',
                'await sleep(1);',
                'return { first: help[0].path, bots };',
            ].join('\n'),
            { timeoutMs: 1000, globals: g },
        );
        expect(r.outcome).toBe('ok');
        expect(r.value).toEqual({ first: 'diy2.bots.list', bots: ['a', 'b'] });
        expect(calls).toEqual(['bots.list']);
    });

    it('模型拿不到 process / require（连 api 之外的口子都不给）', async () => {
        const r = await runtime.run('return [typeof process, typeof require, typeof globalThis.process];', {
            timeoutMs: 1000,
            globals: makeGlobals({ api: {} }),
        });
        expect(r.value).toEqual(['undefined', 'undefined', 'undefined']);
    });
});

describe('formatApiHelp', () => {
    it('有 desc 的带说明，没 desc 的只给路径', () => {
        expect(
            formatApiHelp([
                { path: 'diy2.bots.list', desc: '列 bot', mode: 'unary' },
                { path: 'diy2.bots.update', mode: 'unary' },
            ]),
        ).toBe('- diy2.bots.list — 列 bot\n- diy2.bots.update');
    });

    it('空清单给一句明确的话（不是空字符串）', () => {
        expect(formatApiHelp([])).toContain('没有挂任何 RPC');
    });
});

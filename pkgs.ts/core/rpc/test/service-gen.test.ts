// service-gen.test.ts — 从 api 树生成两端类型声明
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../src/core/index';
import { renderServiceTypes, zodToTs } from '../src/core/service-gen';

const api = RpcSchema.router({
    math: RpcSchema.router({
        add: RpcSchema.unary({
            input: { a: z.number(), b: z.number() },
            output: z.number(),
            desc: 'a + b',
        }),
        div: RpcSchema.unary({
            input: { a: z.number(), b: z.number().int() },
            output: z.object({ q: z.number(), r: z.number() }),
        }),
    }),
    sys: RpcSchema.router({
        ping: RpcSchema.unary({ input: {}, output: z.string() }),
        list: RpcSchema.unary({
            input: { tags: z.array(z.string()), limit: z.number().optional() },
            output: z.array(z.object({ id: z.string(), ok: z.boolean() })),
        }),
    }),
});

describe('zodToTs', () => {
    it('基础标量 / 对象 / 数组 / 可选', () => {
        expect(zodToTs(z.string())).toBe('string');
        expect(zodToTs(z.number())).toBe('number');
        expect(zodToTs(z.boolean())).toBe('boolean');
        expect(zodToTs(z.object({ a: z.string() }))).toBe('{ a: string }');
        expect(zodToTs(z.array(z.string()))).toBe('string[]');
        expect(zodToTs(z.string().optional())).toBe('string');
        expect(zodToTs(z.object({ a: z.string().optional() }))).toBe('{ a?: string }');
    });
    it('空对象 / 联合 / 枚举 / 字面量', () => {
        expect(zodToTs(z.object({}))).toBe('Record<string, never>');
        expect(zodToTs(z.union([z.string(), z.number()]))).toBe('string | number');
        expect(zodToTs(z.enum(['a', 'b']))).toBe('"a" | "b"');
        expect(zodToTs(z.literal('x'))).toBe('"x"');
    });
    it('认不出的构造 → unknown（宁宽不错）', () => {
        expect(zodToTs(z.custom(() => true))).toBe('unknown');
        expect(zodToTs(undefined)).toBe('unknown');
    });
});

describe('renderServiceTypes', () => {
    const dts = renderServiceTypes('Math', api);

    it('生成 client / server 两组接口', () => {
        expect(dts).toContain('export interface MathClient');
        expect(dts).toContain('export interface MathServer');
    });

    it('命名空间 + 方法都出来了', () => {
        expect(dts).toMatch(/math:\s*\{/);
        expect(dts).toMatch(/sys:\s*\{/);
        expect(dts).toMatch(/add\(input: \{ a: number; b: number \}/);
        expect(dts).toMatch(/ping\(input: Record<string, never>/);
    });

    it('客户端一定 Promise，服务端允许同步', () => {
        // client 行
        expect(dts).toMatch(/add\(input: [^)]*\): Promise<number>/);
        // server 行
        expect(dts).toMatch(/add\(opts: \{ input: [^}]*\}[^)]*\): number \| Promise<number>/);
    });

    it('desc 搬进 JSDoc', () => {
        expect(dts).toContain('/** a + b */');
    });

    it('嵌套对象 / 数组 / 可选都正确', () => {
        expect(dts).toContain('{ q: number; r: number }');
        expect(dts).toContain('string[]');
        expect(dts).toContain('limit?: number');
        expect(dts).toContain('{ id: string; ok: boolean }[]');
    });

    it('生成物是合法 TS（能被 tsc 接受）—— 这里只做形状自检', () => {
        expect(dts.startsWith('// ⚠️ 自动生成')).toBe(true);
        expect(dts).toContain("import type { RpcCallOptions } from '@diy-agent/rpc';");
    });
});

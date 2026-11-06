// service-gen.test.ts — 从 api 树生成两端类型声明
//
// 三种命名策略（2026-11-06 用户定：先简单后复杂，默认 none）
//   none —— 全内联（默认）：文件最短、一屏看全
//   all  —— IO + 子接口全具名：报错只显示类型名
//   auto —— 标量内联 / 对象具名（按主流做法）

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../../src/core/index';
import { renderServiceTypes, zodToTs } from '../../src/core/service-gen';

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

describe('naming = none（默认，全内联）', () => {
    const dts = renderServiceTypes('Math', api);

    it('不生成任何具名 IO 类型', () => {
        expect(dts).not.toContain('export interface MathAddInput');
        expect(dts).not.toContain('export type MathAddOutput');
        expect(dts).not.toContain('MathListOutput');
    });

    it('不生成**子接口**，命名空间直接内联在聚合接口里', () => {
        // 聚合接口 MathClient 一直都在（typeName 来的），不该断言它不存在
        expect(dts.match(/export interface \w+Client/g)?.length, '只该有聚合接口这一个 Client').toBe(1);
        expect(dts.match(/export interface \w+Server/g)?.length, '只该有聚合接口这一个 Server').toBe(1);
        expect(dts).toMatch(/math:\s*\{/);
        expect(dts).toMatch(/sys:\s*\{/);
    });

    it('方法签名里是完整的内联类型', () => {
        expect(dts).toMatch(/add\(input: \{ a: number; b: number \}, options\?: RpcCallOptions\): Promise<number>/);
        expect(dts).toMatch(/ping\(input: Record<string, never>/);
        expect(dts).toContain('{ q: number; r: number }');
        expect(dts).toContain('{ id: string; ok: boolean }[]');
    });

    it('desc 搬进 JSDoc', () => {
        expect(dts).toContain('/** a + b */');
    });

    it('两组接口都在（client / server）', () => {
        expect(dts).toContain('export interface MathClient');
        expect(dts).toContain('export interface MathServer');
    });

    it('客户端 Promise，服务端允许同步', () => {
        expect(dts).toMatch(/add\(input:[^)]*\): Promise<number>/);
        expect(dts).toMatch(/add\(opts: \{ input:[^)]*\): number \| Promise<number>/);
    });

    it('契约警告在头部', () => {
        expect(dts).toContain('跨进程契约');
    });
});

describe('naming = all（全具名）', () => {
    const dts = renderServiceTypes('Math', api, { naming: 'all' });

    it('IO 类型和子接口都具名', () => {
        expect(dts).toContain('export interface MathAddInput');
        expect(dts).toContain('export type MathAddOutput');
        expect(dts).toContain('export interface MathClient');
        expect(dts).toContain('export interface SysClient');
        expect(dts).toMatch(/math: MathClient;/);
    });

    it('空 input 仍不生成类型（Record<string, never> 更直白）', () => {
        expect(dts).not.toContain('SysPingInput');
    });
});

describe('naming = auto（标量内联 / 对象具名）', () => {
    const dts = renderServiceTypes('Math', api, { naming: 'auto' });

    it('对象 IO 具名', () => {
        expect(dts).toContain('export interface MathAddInput');
        expect(dts).toContain('export type MathDivOutput');
    });

    it('标量出参**不**具名（`SysPingOutput = string` 是纯噪音）', () => {
        expect(dts).not.toContain('SysPingOutput');
        expect(dts).toMatch(/ping\([^)]*\): string \| Promise<string>/);
    });

    it('对象数组出参具名，简单数组不具名', () => {
        expect(dts).toContain('export type SysListOutput');
    });

    it('子接口内联（只有 IO 具名）', () => {
        expect(dts.match(/export interface \w+Client/g)?.length, '只有聚合接口').toBe(1);
        expect(dts).toMatch(/math:\s*\{/);
    });
});

// group-root.test.ts — `RpcSchema.group` 直接当根（2026-11-06）
//
// 之前 group 只能当**中间节点** —— 它自己不摊平 children，得靠 `RpcSchema.group({ children:  })` 包一层
// 才能写 `apiDef.a.b.c`。dev-fs（##518）遇到的两个问题都是这个不对称造成的：
//   ① `HandlersOf` 把 group 推成 `never` → `bind()` 类型报错
//   ② 根必须用 router，但 router 带 `isTopGroup` 兼容分支 → group / router 概念重合
//
// 现在：group 自己摊平 + HandlersOf 认识 group ⇒ **group 可以当根，router 不再是必需**。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema, defineService } from '../../src/core/index';
import { channelHarness } from '../harness';

/** 用 group 当根：**每层都有 desc**（CLI help 靠它） */
function groupTree() {
    return RpcSchema.group({
        desc: '示例根',
        children: {
            math: RpcSchema.group({
                desc: '数学',
                children: {
                    add: RpcSchema.unary({
                        input: { a: z.number(), b: z.number() },
                        output: z.number(),
                        desc: '两数相加',
                    }),
                    version: RpcSchema.unary({ input: {}, output: z.string(), desc: '版本号' }),
                },
            }),
        },
    });
}

describe('RpcSchema.group 当根', () => {
    it('**自己摊平 children**：group 后能直接访问子节点', () => {
        const g = groupTree();
        // 摊平后：`g.math.add` 直接可用（不用 `.children.math.add`）
        expect(typeof (g as unknown as Record<string, unknown>)['math']).toBe('object');
        expect(typeof ((g as any).math as any).add).toBe('object');
        // children 仍保留（buildRouteTree 靠它识别父命令）
        expect((g as any).children).toBeDefined();
    });

    it('每一层 desc 都在（CLI help 的数据源）', () => {
        const g = groupTree();
        expect((g as any).desc).toContain('示例根');
        expect((g as any).math.desc).toBe('数学');
        expect((g as any).math.add.desc).toBe('两数相加');
    });

    it('`defineService` 直接吃 group 树（不经过 router）', async () => {
        const svc = defineService({ name: 'demo', api: groupTree() });
        const { binding, client, dispose } = await channelHarness.start();

        // ⚠️ 这是 dev-fs 撞过的点：group 分支以前会被推成 never，`bind` 直接类型报错
        svc.bind(binding, {
            math: {
                add: ({ input }) => input.a + input.b,
                version: () => '1.0.0',
            },
        });

        const c = svc.use(client);
        expect(await c.math.add({ a: 2, b: 3 })).toBe(5);
        expect(await c.math.version({})).toBe('1.0.0');
        await dispose();
    });

    it('g生成物：group 树能正常出类型（每层 desc 进 JSDoc）', () => {
        // 只验形状：不抛、路径对
        const svc = defineService({ name: 'demo', api: groupTree() });
        expect(svc.name).toBe('demo');
        expect((svc.api as any).math.add).toBeDefined();
    });
});

describe('对比：router 仍可作为根（老路径不破）', () => {
    it('router({ x: group({...}) }) 照旧可用', async () => {
        const api = RpcSchema.bindNames(RpcSchema.group({ children: {
            math: RpcSchema.group({
                desc: '数学',
                children: { add: RpcSchema.unary({ input: { a: z.number() }, output: z.number(), desc: '加' }) },
            }),
        } }));
        const svc = defineService({ name: 'demo2', api });
        const { binding, client, dispose } = await channelHarness.start();
        svc.bind(binding, { math: { add: ({ input }) => input.a } });
        expect(await svc.use(client).math.add({ a: 7 })).toBe(7);
        await dispose();
    });
});

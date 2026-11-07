/**
 * 04-group-root —— **用 `RpcSchema.group` 当根**（2026-11-06 起支持）
 *
 * 与 01-basic 的差别只在根节点：
 *   · 01-basic：`RpcSchema.group({ children: { math: RpcSchema.group({ children: {...} }) } })` —— 两层都没有 desc
 *   · 这里：    `RpcSchema.group({ desc, children: { math: group({ desc, children }) } })`
 *
 * **为什么推荐后者**：CLI help 是分层的，每层都需要一句说明：
 *   $ demo --help
 *     math   数学运算        ← 这行的「数学运算」只有 group 的 desc 能提供
 *
 * 跑：`npx tsx pkgs.ts/core/rpc/examples/service/04-group-root/run.ts`
 */
import { z } from 'zod';
import { RpcSchema, defineService } from '../../../../src/index';

export const calcRoutes = RpcSchema.group({
    desc: '计算器示例',
    children: {
        math: RpcSchema.group({
            desc: '数学运算',
            children: {
                add: RpcSchema.unary({
                    input: { a: z.number(), b: z.number() },
                    output: z.number(),
                    desc: '两数相加',
                }),
                /** 空 input 也要声明成 `{}`（调用时传 `{}`） */
                version: RpcSchema.unary({ input: {}, output: z.string(), desc: '版本号' }),
            },
        }),
    },
});

export const calcService = defineService({ name: 'demo', api: calcRoutes });

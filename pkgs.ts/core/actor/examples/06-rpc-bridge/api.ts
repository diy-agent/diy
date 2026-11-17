// api.ts — 桥的**契约**，两端共享。这个文件必须无副作用（不建 actor、不连管子）：
// 客户端 import 它只为了拿到「有哪些方法、入参什么形状」。

import { RpcSchema } from '@diy-agent/rpc';
import { z } from 'zod';

/**
 * 每个方法一条 `RpcSchema.unary`，两条 shape 都必填：`input` 和 `output`。
 * 这个 3 行的 helper 只是省掉重复的 `output: z.unknown()`；
 * 你完全可以直接写 `RpcSchema.unary({ input, output })`。
 */
const unary = <const TSchema extends Record<string, z.ZodTypeAny>, TOutput = unknown>(
    input: TSchema = {} as TSchema,
    output: z.ZodType<TOutput> = z.unknown() as z.ZodType<TOutput>,
) => RpcSchema.unary({ input, output });

// ══ 桥接的代价，就在这里 ═════════════════════════════════════════════════
//
// 1. 每个方法一行声明（不能从 room.ts 的类型自动推出来）
// 2. `input` 是**对象**（rpc 的统一入参），所以位置参数要包一层 `args` 数组 ——
//    actor 的 `say(who, text)` 到了线上变成 `{ args: [who, text] }`
//
// `z.array(z.unknown())` 等于不校验。想校验就写 `z.tuple([z.string(), z.string()])`，
// 那时对面传错类型会在**进方法之前**被拒 —— 这是桥接白送的一层。
//
// `output: z.unknown()` 等于客户端拿到的返回值是 unknown（要自己 cast）。
// 写成真 shape（`z.object({ seq: z.number(), ... })`）客户端就有类型了，
// 代价是它和 room.ts 的返回类型变成两份真源。范例选了 cast，见 index.ts。
export const roomApi = RpcSchema.group({
    children: {
        say: unary({ args: z.array(z.unknown()) }),
        slow: unary({ args: z.array(z.unknown()) }, z.string()),
        log: unary(),
        lastSlow: unary({}, z.string()),
    },
});

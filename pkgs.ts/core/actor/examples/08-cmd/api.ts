// 08 — 契约。**客户端只 import 这个文件**：没有实现，也就没有 node:fs 能顺着 import 图爬进包里。
//
// 和 06 的 api.ts 是同一个位置、同一个作用，区别只是这里用 cmd() 声明，
// 于是参数/返回类型在 impl 那侧自动推出来，不用手写第二遍。
import { z } from 'zod';
import { cmd } from '../../src/cmd.js';

export const roomApi = {
    // 入参 shape 顺带起到校验作用：who 传空串会被 rpc 拦在进方法之前
    say: cmd({ input: { who: z.string().min(1), text: z.string() }, output: z.number() }),

    // 出参 schema 只推类型，没有运行时开销，所以写精确的 shape
    lines: cmd({ input: {}, output: z.array(z.object({ seq: z.number(), text: z.string() })) }),

    // 要感知取消就读 handler 的 ctx.signal —— 和 04 是同一个信号
    slow: cmd({ input: { ms: z.number() }, output: z.string() }),

    boom: cmd({ input: { msg: z.string() }, output: z.void() }),
};

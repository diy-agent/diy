// hello-counter.ts — 入门用的那一个 kind（声明部分，两个入门范例共用它）。
//
// 一个 kind = 一份契约：状态形状 + 能收的命令 + 会发的事件。写一次，进程内外、跨机器都一样。
//
// 三条规矩（写在下面代码的注释里，因为这是最容易写歪的地方）：
//   ① `ctx.state` 只读 —— 改状态 = **返回新的 state**，不许就地改；
//   ② 事件集合是**封闭**的：只能发这里声明过的名字；
//   ③ 一次命令 = 一次原子提交：新状态 + 要追加的事件一起落，不会只落一半。

import { z } from 'zod';

import { defineKind } from '../src/index.js';

export const counter = defineKind({
    name: 'hello.counter',

    // 状态长什么样。actor 重启后靠它（+ 事件日志）恢复，所以它必须能被 JSON 化。
    state: z.object({ n: z.number().int() }),
    initial: () => ({ n: 0 }),

    // 事件是**对外公告**发生了什么；名字封闭，载荷有 schema。
    events: { added: z.object({ by: z.number().int(), n: z.number().int() }) },
})
    .command(
        'add',
        { input: z.object({ by: z.number().int() }), output: z.object({ n: z.number().int() }) },
        (ctx, { by }) => {
            const n = ctx.state.n + by;
            // 返回三样：给调用方的 output、提交后的 state、要追加的事件
            return { output: { n }, state: { n }, events: [{ name: 'added', data: { by, n } }] };
        },
    )
    // 查询：读路径。读的是**同一份已提交的状态**，不排队、不改东西。
    .query('get', { input: z.object({}), output: z.object({ n: z.number().int() }) }, (ctx) => ({ n: ctx.state.n }))
    .build();

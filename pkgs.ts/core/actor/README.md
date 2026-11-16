# @diy-agent/actor

actor 协议内核：**一个实例 = 一个 actor**（单写者串行队列）+ 声明式 kind + 帧口径 + 事件日志 + 多目标扇出。

零 IO、零全局状态，**不依赖 `@diy-agent/rpc`**（传输层只要求一个 `Link`，ws/http 适配器在别的包里写）。

```ts
import { z } from 'zod';
import { createLocalActor, defineKind } from '@diy-agent/actor';

const counter = defineKind({
    name: 'demo.counter',
    state: z.object({ n: z.number().int() }),
    initial: () => ({ n: 0 }),
    events: { added: z.object({ by: z.number().int(), n: z.number().int() }) },
})
    .command('add', { input: z.object({ by: z.number().int() }), output: z.object({ n: z.number().int() }) }, (ctx, input) => {
        const n = ctx.state.n + input.by;
        return { output: { n }, state: { n }, events: [{ name: 'added', data: { by: input.by, n } }] };
    })
    .query('get', { input: z.object({}), output: z.object({ n: z.number().int() }) }, (ctx) => ({ n: ctx.state.n }))
    .build();

const { client } = await createLocalActor({ kind: counter, uri: 'diy://local/counter' });
await client.cmd('add', { by: 1 });          // { ok: true, accepted: false, data: { n: 1 }, seq }
await client.query('get', {});               // { ok: true, data: { n: 1 }, watermark, stale }
```

## 文档（真源）

设计、口径、歧义账、路线图都在 [`docs/`](./docs/README.md)（从 `docs/README.md` 开始读）。
其中三条最容易被改坏：

1. `data` 里只装 kind 声明过的东西（[docs/02](./docs/02-wire.md)）；
2. `type` 只说执行成了没有，业务结果在 `data` —— **帧上没有 `partial`**（[docs/05](./docs/05-multi-target.md)）；
3. 摆放知识只属于 actor：`targets` 由 kind 从 state 算，调用方不许指定（[docs/05](./docs/05-multi-target.md)）。

## 开发

```bash
./sha.sh check       # 类型 + lint
./sha.sh test        # 单测（tests/*.test.ts，全部 intent 测试）
./sha.sh build       # src/ → dist/（Node 可直接 import 的 ESM + .d.ts）
```

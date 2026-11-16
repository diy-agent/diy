# actor 方案（`@diy-agent/actor`）

> 这套文档是 actor 协议的**唯一真源**。旧文档 `docs/actor-protocol-naming.md` 已删除，
> 内容里的歧义账迁进 [07-naming-ledger.md](./07-naming-ledger.md) 并逐条标了落地状态。
>
> 代码就在本包里（`src/`），每篇文档末尾都标了它对应的源文件。**文档与代码不一致时以代码为准，
> 但必须立刻改文档** —— 这套东西的价值全在「口径统一」上，口径一裂就退回原来那样。

## 一句话

> **一个实例 = 一个 actor：所有会动状态的操作排成一条队列，一次跑一个；
> 对外只有三个动词 `cmd`（写）/ `query`（读）/ `watch`（事件流）。**

起因见 [01-model.md](./01-model.md)：「点了两次新建只多一个」「改完名字刷新又变回去」这类 bug
全部来自 UI 直接读写存储、多个操作交叉。actor 把「谁来改状态」收敛到唯一一个执行体。

## 读哪篇

| 篇目 | 回答什么问题 | 你什么时候需要它 |
|---|---|---|
| [00-overview.md](./00-overview.md) | 这个包是什么、不是什么；边界在哪 | 第一次看，或者想加依赖/加能力时 |
| [01-model.md](./01-model.md) | 为什么必须单写者；长任务怎么办；跨实例怎么划分 | 想绕过队列（九成会后悔）之前 |
| [02-wire.md](./02-wire.md) | 帧长什么样；`type` 和 `data` 各管什么；错误码 | 加字段 / 改协议 / 写传输适配器 |
| [03-kinds.md](./03-kinds.md) | 怎么声明一个 actor（state / commands / queries / events） | 写新 kind |
| [04-runtime.md](./04-runtime.md) | 队列怎么跑；幂等；提交是原子的；崩溃怎么恢复 | 怀疑“状态和事件对不上”时 |
| [05-multi-target.md](./05-multi-target.md) | 多目标扇出；为什么**没有** `partial` | 要查多个成员/多台机器时 |
| [06-transport.md](./06-transport.md) | 链路怎么接；调用方 facade 怎么用；重试与一致性 | 接 ws/http；写 CLI/UI |
| [07-naming-ledger.md](./07-naming-ledger.md) | 哪些字段名历史上被用歪了，随哪一刀改 | 改到 room / journal 相关代码前**必读** |
| [08-roadmap.md](./08-roadmap.md) | 还没做什么；下一步顺序 | 排期 / 判断能不能依赖它 |
| [09-hello.md](./09-hello.md) | **入门**：单进程 40 行、两进程 40 行，三个动词怎么用 | 第一次上手；给别人讲这套东西的开头 |
| [10-scenario.md](./10-scenario.md) | 3 个真进程跑一遍；适配器与落盘 store 长什么样 | 接 ws/http / 写 store 实现 / 要证据 |

## 三十秒版

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

await client.cmd('add', { by: 1 });                      // → { ok: true, accepted: false, data: { n: 1 }, seq }
const got = await client.query('get', {});               // → { ok: true, data: { n: 1 }, watermark, stale }
for await (const e of client.watch({ include: ['added'] })) console.log(e.name, e.data);
```

`tests/` 里跑的就是这些示例（`tests/support/fixtures.ts` 是同一份 kind），所以示例不会烂。

## 五条不可谈判的口径

1. **`data` 里只装 kind 声明过的东西；`data` 外面的一切都是 runtime 的。**（[02](./02-wire.md)）
2. **`type` 只说执行成了没有，业务结果一律在 `data`**；所以帧上永远没有 `partial`。（[02](./02-wire.md) / [05](./05-multi-target.md)）
3. **改状态 = 返回新的 `state`**，不在 ctx 上偷偷改；事件与状态一起提交。（[03](./03-kinds.md) / [04](./04-runtime.md)）
4. **摆放知识只属于 actor**：`targets` 由 kind 从 state 算，调用方不许指定。（[05](./05-multi-target.md)）
5. **`commandId` 由调用方持有**：同一个 id 重发 = 幂等重试，新 id = 新命令。（[04](./04-runtime.md) / [06](./06-transport.md)）

## 判据（自查用）

```bash
# 1. 没人在协议层造“部分成功”
rg -n "partial" pkgs.ts/core/actor/src        # 只应出现在注释里的“已否决”说明中

# 2. 没人绕过队列碰状态：状态只在 handler 返回值里出现
rg -n "state\s*=" pkgs.ts/core/actor/src      # 只应命中 runtime 内部提交路径

# 3. UI 不读执行回执（读了就是把 placement 拖回渲染层）
rg -n "meta\.fanout" pkgs.ts/ui               # 应为 0

# 4. 本包不依赖 rpc
rg -n "@diy-agent/rpc" pkgs.ts/core/actor     # 应为 0（含 package.json）
```

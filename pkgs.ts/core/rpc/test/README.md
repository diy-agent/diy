# rpc 的测试

两个目录，按**写法**分，不按被测对象分。

```
test/
├── legacy/    ← 底层机制：RpcSchema + binding.on(meta, handler) + createTypedClient
├── service/   ← 模块化写法：defineService + bind/use
├── harness.ts  ← 传输 harness（channel / http / ws / ipc 参数化）
└── helpers.ts
```

## 为什么分两个目录

2026-11-06 起 **`defineService` 是主要开发手段**，`binding.on(meta, handler)` 这种
「动态类型泛型」退到库的内部机制（可理解性太差，是否保留待观察）。

测试照这个分层放 —— 读 `legacy/` 的人知道自己在看底层，读 `service/` 的人看的是日常用法。

## `service/` —— 新写法（日常开发看这里）

| 文件 | 覆盖 |
|---|---|
| `service.test.ts` | `bind` / `use` / 前缀 / 越界 / 缺 handler / 同一 api 挂两个 service |
| `service-gen.test.ts` | `zodToTs` 各构造 / 三种命名策略（none / all / auto）|

## `legacy/` —— 底层机制（**大部分不该改**）

| 文件 | 测什么 | 该改成新写法吗 |
|---|---|---|
| `binding.test.ts` | 四种 stream mode × 各传输参数化 | ❌ `defineService` 只做名字与注册，stream 语义在它之下 |
| `rpc-core.test.ts` | `RpcSchema` + `binding.on` + `createTypedClient` 场景 | ❌ 这正是 `defineService` 的基石 |
| `rpc-routing.test.ts` | 多后端共享单一 binding 的路由归属 | ❌ 底层路由 |
| `cancel-propagation.test.ts` | 消费端离开 ⇒ 上游收尾（跨传输）| ❌ 取消语义在传输层 |
| `intent.cancel.test.ts` | 取消与生命周期「意图测试」（102 条）| ❌ 同上 |
| `protocol-envelopes.test.ts` | 收发的原始 `_Envelope` 序列 | ❌ 协议层 |
| `http-resource` / `http-specific` / `ws-specific` | 传输特有行为 | ❌ 传输层 |
| `duplex-frames.test.ts` | 双工帧归属 | ❌ 传输层 |
| `cli-app` / `cli-parser` | CLI 命令树 / 参数解析 | ❌ CLI 层 |

### 判断依据

**问自己：这个测试能不能只用 `defineService` 表达？**

- 能（测「注册 + 调用」的业务语义）⇒ 该用新写法
- 不能（测传输 / 协议 / 取消 / 路由）⇒ 留在 `legacy/`

**目前全部 `legacy/` 都属于后者** —— 它们测的东西在 `defineService` 之上或之下，
换写法只会把「底层契约」的测试变成「用它的人写得好不好」。

## 补一个测试时怎么写

**新增业务行为** → `service/`：

```ts
import { describe, expect, it } from "vitest";
import { RpcSchema, defineService } from "../../src/core/index";
import { channelHarness } from "../harness";

const svc = defineService({
    name: "demo.x",
    api: RpcSchema.router({ foo: RpcSchema.unary({ input: {}, output: z.number() }) }),
});

it("...", async () => {
    const { binding, client, dispose } = await channelHarness.start();
    svc.bind(binding, { foo: () => 1 });
    expect(await svc.use(client).foo({})).toBe(1);
    await dispose();
});
```

**新增协议 / 传输行为** → `legacy/`，用 `harness.ts` 的参数化 harness。

## 一个从 example 里学到的坑

```ts
// ❌ serverStream 是 async 方法，直接 for await 会拿到 Promise
for await (const x of c.job.progress({ n: 3 })) { ... }

// ✅ 先 await 拿句柄
const stream = await c.job.progress({ n: 3 });
for await (const x of stream) { ... }
```

`StreamHandle` 有 `[Symbol.asyncIterator]`，但**得到它的过程是异步的**。

# 09 · 入门：两个 40 行的范例

> 对应源码：`examples/hello-counter.ts`（kind）、`examples/hello-inproc.ts`（入门一）、
> `examples/hello-net.ts`（入门二）
> 运行：`./sha.sh hello` / `./sha.sh hello-net`（各不到 1 秒）

这一页只讲三件事：**怎么声明、怎么接线、三个动词怎么用**。别的（落盘、扇出、掉线、重启）
一概不出现 —— 那些在 [10-scenario.md](./10-scenario.md)，别在这里先看。

## 一、先看契约：一个 kind 就是一份声明

`examples/hello-counter.ts`（36 行，全部）

```ts
const counter = defineKind({
    name: 'hello.counter',
    state: z.object({ n: z.number().int() }),      // 状态长什么样
    initial: () => ({ n: 0 }),
    events: { added: z.object({ by: z.number().int(), n: z.number().int() }) },   // 封闭集合
})
    .command('add', { input: z.object({ by: z.number().int() }), output: z.object({ n: z.number().int() }) },
        (ctx, { by }) => {
            const n = ctx.state.n + by;
            return { output: { n }, state: { n }, events: [{ name: 'added', data: { by, n } }] };
        })
    .query('get', { input: z.object({}), output: z.object({ n: z.number().int() }) },
        (ctx) => ({ n: ctx.state.n }))
    .build();
```

三条规矩，写歪任何一条后面都会痛：

1. **`ctx.state` 只读**：改状态的方式是**返回一个新的 `state`**。想在 handler 里 `ctx.state.n++`？构造上做不到。
2. **事件名字是封闭的**：只能发 `events` 里声明过的；发门外的事件在开发期就报错。
3. **一次命令 = 一次原子提交**：返回的 `state` 和 `events` 一起落盘，不存在「状态改了、事件没发」。

## 二、入门一：单进程，没有网络

`examples/hello-inproc.ts` 的正文只有这些（`./sha.sh hello`）：

```ts
const { client, actor } = await createLocalActor({ kind: counter, uri: 'hello://counter' });

const written = await client.cmd('add', { by: 2 });      // 写
console.log('query →', await client.query('get', {}));   // 读
for await (const event of client.watch({ include: ['added'] })) { ... break; }   // 事件流
```

输出（这就是全部，没有别的东西）：

```
cmd   → { ok: true, accepted: false, data: { n: 2 }, seq: 'e1' }
query → {"ok":true,"data":{"n":2},"watermark":"e1","stale":false}
watch → added { by: 2, n: 2 } seq = e1
```

三个动词各自回什么：

| 动词 | 回什么 | 关键那一位 |
|---|---|---|
| `cmd` | `{ ok, accepted, data, seq }` | `seq` = 这次提交在事件流里的位置 |
| `query` | `{ ok, data, watermark, stale }` | `watermark` = 读到哪个位置；`stale` = 读的是不是旧的 |
| `watch` | 异步迭代，逐条事件 | `seq` = 同一条事件流上的位置（于是能续传） |

两个容易误解的地方：

- **失败是返回值，不是异常**：`{ ok: false, code, message, retryable }`。想当异常处理就包一层
  `expect()`（就是这么用的，它只做这一件事）。
- **`watch` 是 async generator**：先补历史再追实时；不 `break` 就一直等。它没有「取消」接口，
  停止方式就是不再迭代。

## 三、入门二：两个进程，中间一条 socket

`examples/hello-net.ts`（`./sha.sh hello-net`）。和入门一的差别**只有接线这 3 行**：

```ts
// 服务端（子进程）：kind + socket 就够，不用逐条绑方法
await serveActor({ kind: counter, uri: 'hello://counter', socket });

// 调用方（父进程）：拨号
const client = await connectActor({ kind: counter, socket });
```

之后 `cmd` / `query` / `watch` 一个字都不用改 —— 进程边界对业务代码是透明的。
输出和入门一逐行对齐（值不同：这次 `by: 3`）：

```
[server] 在听 /var/folders/.../hello-actor-67084.sock
cmd   → { ok: true, accepted: false, data: { n: 3 }, seq: 'e1' }
query → {"ok":true,"data":{"n":3},"watermark":"e1","stale":false}
watch → added { by: 3, n: 3 } seq = e1
```

两个真实的坑（第一版就踩了第一个）：

- **socket 路径由父进程定、再传给子进程**。父子是两个进程、pid 不同，各自拿 `process.pid` 拼路径
  就会各听一个地方，调用方看到的是 `ENOENT`。
- **子进程起来要时间**：`waitForSocket()` 拨通一次才算好，不要 `spawn` 完立刻连。

## 四、为什么只有这些

这份入门刻意**不带**四样东西（每一样都值得单独讲，一起塞进来就没人看得完了）：

| 没带 | 为什么 | 去哪看 |
|---|---|---|
| 落盘 store | 入门的 actor 死了就死了，不影响理解三个动词 | [10](./10-scenario.md) 六 |
| 扇出（一次查询问多个 actor） | 需要至少 3 个 actor 才有意义 | [05](./05-multi-target.md) |
| 掉线 / 三态 | 需要 `kill -9` 才能造出来 | [10](./10-scenario.md) 四 |
| 崩溃恢复、跨重启幂等 | 需要重启 | [10](./10-scenario.md) 四、[04](./04-runtime.md) |

当年写这套东西的动机、为什么必须单写者，看 [01](./01-model.md)；
帧为什么长两层（`type` / `data`），看 [02](./02-wire.md)。

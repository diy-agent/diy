# 09 · 入门：两个 40 行的范例

> 对应源码：`examples/hello-counter.ts`（kind）、`examples/hello-inproc.ts`（入门一）、
> `examples/hello-net.ts`（入门二）
> 运行：`./sha.sh hello` / `./sha.sh hello-net`（各不到 1 秒）

这一页只讲三件事：**怎么声明、怎么接线、方法怎么调**。别的（落盘、扇出、掉线、重启）
一概不出现 —— 那些在 [10-scenario.md](./10-scenario.md)，别在这里先看。

调用写法是**函数级**的：`await hello.add({ by: 2 })` 直接是 `{ n: 2 }`，
不是 `{ ok, data }` 那个联合。这正是它和 rpc 范例对齐的地方（[06](./06-transport.md) §四）。

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

// 契约 → 一组有类型的方法：名字、入参、出参全从 schema 推
const hello = useKind(counter, client);

const off = hello.$on('added', (event) => console.log('event →', event));   // 事件：先订阅再动

console.log('add   →', await hello.add({ by: 2 }));   // 写：直接是 { n: 2 }
console.log('get   →', await hello.get({}));          // 读：直接是 { n: 2 }

off();
console.log('raw   →', await client.cmd('add', { by: 1 }));   // 这一层之下：Outcome
```

输出（这就是全部，没有别的东西）：

```
event → { by: 2, n: 2 }
add   → { n: 2 }
get   → { n: 2 }
raw   → { ok: true, accepted: false, data: { n: 3 }, seq: 'e2' }
```

调用这一层的三条性质：

| 性质 | 意味着什么 |
|---|---|
| **方法名就是契约里的名字** | 拼错 → 编译期红；`hello.nope()` 根本不存在 |
| **入参/出参从 schema 推** | `hello.add({ byN: 1 })` 编译期红；`await hello.get({})` 的 `n` 是 `number` |
| **失败抛 `ActorError`** | 不用每处写 `if (!outcome.ok)`；`code` / `retryable` 原样带上来 |

事件侧对应两样（`$` 前缀是协议给的，不是业务声明的）：

- `$on(name, handler)`：**实时**事件，返回退订函数。订阅之前发生的不补 —— 上面之所以先 `$on` 再 `add`。
- `$watch({ after })`：补历史 + 追实时，是 async generator（不 `break` 就一直等；要真中断传 `signal`）。

想连历史一起收，就用 `$watch`；只想「从现在起」跟着走，用 `$on`。两者的载荷都有类型，按 `name` 收窄。

### 这一层之下：raw 层

最后那行 `raw →` 是**同一个 client** 的原始写法，也就是函数层底下真发生的事：

| | 函数层（`useKind`） | raw 层（`client`） |
|---|---|---|
| 写 | `await hello.add({ by: 2 })` → `{ n: 2 }` | `await client.cmd('add', { by: 2 })` → `{ ok, data, seq }` |
| 读 | `await hello.get({})` → `{ n: 2 }` | `await client.query('get', {})` → `{ ok, data, watermark, stale }` |
| 失败 | 抛 `ActorError` | 返回值 `{ ok: false, code, message, retryable }` |

业务代码用左边（默认），网关/转发/要拿 `seq`、`watermark`、`meta.fanout` 的用右边。
两层的完整说明在 [06](./06-transport.md) §四。

## 三、入门二：两个进程，中间一条 socket

`examples/hello-net.ts`（`./sha.sh hello-net`）。和入门一的差别**只有接线那 2 行**：

```ts
// 服务端（子进程）：kind + socket 就够，不用逐条绑方法
await serveActor({ kind: counter, uri: 'hello://counter', socket });

// 调用方（父进程）：拨号
const client = await connectActor({ kind: counter, socket });
```

之后那几行调用一个字都不用改 —— 函数层只认契约，不认链路：

```ts
const hello = useKind(counter, client);
const off = hello.$on('added', (event) => console.log('event →', event));
console.log('add   →', await hello.add({ by: 3 }));
console.log('get   →', await hello.get({}));
```

输出和入门一逐行对齐（值不同：这次 `by: 3`）：

```
[server] 在听 /var/folders/.../hello-actor-87083.sock
event → { by: 3, n: 3 }
add   → { n: 3 }
get   → { n: 3 }
raw   → { ok: true, accepted: false, data: { n: 4 }, seq: 'e2' }
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

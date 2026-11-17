# 这个包为什么没有网络层

内核 `@diy-agent/actor` 是 180 行、零依赖、**零网络代码**。它只有一个 actor 概念：一份私有状态 + 一条串行链 + 一张方法表。

（如果你只想少写点桥接样板，直接跳到[最后那节](#更省事的写法cmd子路径)看 `@diy-agent/actor/cmd`。本文前半部分解释的是它底下那层为什么这么长。）

跨进程是宿主的装配问题，不是 actor 的能力。本文说清边界在哪、桥怎么搭、什么时候干脆别桥。

## 一句话判据

**actor 不知道自己在第几个进程里。** 状态在哪，串行链就在哪；想让另一头也能操作它，就把调用换成帧。换帧这件事跟「状态是什么、方法怎么写」无关 —— 所以它不属于这个包。

## 桥接的形状

```
业务本体          契约           桥                管子
room.ts    ←    api.ts    ←    server.ts    ←    ipc.ts
（方法表）      （shape）      （handlers）      （EnvelopeTransport）
                                    ↑
                              客户端 index.ts
```

四个位置，各自可以独立替换：

| 位置        | 换掉它 =                                    | 谁负责       |
| ----------- | ------------------------------------------- | ------------ |
| `room.ts`   | 改业务                                      | 你           |
| `api.ts`    | 加/删方法                                   | 你           |
| `ipc.ts`    | 从 IPC 换成 ws / http / electron / 内存队列 | **只有这里** |
| `server.ts` | 加一个「转手」（一行）                      | 桥           |

`examples/06-rpc-bridge` 是这四块的完整可运行版（`ipc.ts` 只有 60 行，其中一半是三个通道适配器）。

## 用 rpc，不要自建

仓库里的 `@diy-agent/rpc` 已经有四种 transport（ws / http / electron / mem）、四类调用（unary / server-stream / client-stream / bidi-stream）、zod 校验、错误码、超时、取消帧、断线清理，还有 841 行 CLI 命令树。

自建一套「actor 的网络层」等于做第五种 —— 和上面全部平行但不兼容，于是这些全要重写一遍，且更弱。曾经写过 192 行试过，删了。

对照表：

| 能力             | rpc                                              | 自建 192 行  |
| ---------------- | ------------------------------------------------ | ------------ |
| 取消传到服务端   | cancel 帧（ack 前按 call.id、ack 后按 streamId） | 自己定义     |
| 断线时全部 abort | destroy 钩子                                     | 无           |
| 超时             | `{ timeout }`（init/ack 窗口）                   | 无           |
| 错误码           | `RpcError{ code, details }`                      | 只有 message |
| 双向调用         | 一条管子上 client + server 各挂一个              | 要再建反方向 |
| 多客户端         | 每个连接一个 binding                             | 靠管子自己   |
| CLI 入口         | 现成                                             | 无           |

## 桥接的两个代价

### 1. 每个方法一条声明，input 和 output 都必填

```ts
export const roomApi = RpcSchema.group({
    children: {
        say: RpcSchema.unary({ input: { args: z.array(z.unknown()) }, output: z.unknown() }),
        slow: RpcSchema.unary({ input: { args: z.array(z.unknown()) }, output: z.string() }),
    },
});
```

`input` 和 `output` 都是必填的（`output` 忘了会直接编译不过，这是实际踩到的）。三个后果：

- **多一份声明**：actor 的方法签名推不到 rpc 的 schema 里，所以每个方法手写一行。
- **output 是真源还是 unknown，得选**：写 `z.unknown()` → 客户端拿到 `unknown` 自己 cast；写完整 shape → 客户端有类型，但那个 shape 和方法的返回类型是**两份真源**，改一处会忘另一处。
- **`z.array(z.unknown())` 等于不校验**：写 `z.tuple([z.string(), z.string()])` 才有「进方法之前」的类型检查 —— 一层白送的防线。

这是这套桥接最不优雅的地方。如果方法特别多且搔，正确的解法是**类型生成**（从 TS 类型生成 stub），而不是自建一套不声明 schema 的协议 —— 后者会把上面整张对照表都丢掉。

**已经有一个折中做法**：把 input/output schema 和实现写在一起，用 `cmd({ input, output }, run)` 声明 —— 见[最后那节](#更省事的写法cmd子路径)。它消掉的是「第二份声明」和「每个方法一行转手」，消不掉的是「上游必须是 schema」这件事本身。

### 2. 位置参数要包成对象

rpc 的统一入参是对象（这样 options、流式 init/ack 才有地方放），所以：

```ts
// 本地：room.say('你', '一')
// 线上：{ args: ['你', '一'] }
// 桥里：say: ({ input }) => room.say(input.args[0], input.args[1])
```

`$call('say', ['你', '一'])` 可以免掉这层手工拆包 —— 位置参数原样传进去：

```ts
say: ({ input }) => room.$call('say', input.args),
```

要不要用 `$call` 取决于你想不想在桥里保留签名。`$call` 的 `args` 是 `unknown[]`，方法名也不受类型检查（字符串），所以它只适合「转发」这一种用途 —— 这正是桥在做的事。

**走 `cmd` 子路径时不需要它。** 那条路线把入参约束成一个对象，于是签名变成 `(input, opts?)`，signal 直接当第二个参数传 —— `$call` 想解决的就是这个，问题没了补丁也就不用了。

## 取消：`$call` 的第三个参数

桥里唯一需要「转手」的东西是 signal：

```ts
slow: ({ input, signal }) => room.$call('slow', [input.args[0]], { signal }),
```

于是方法内部：

```ts
async slow(ms: number) {
    for (...) {
        if (life.signal.aborted) return '停下';   // ← 和 04 节本地取消是同一行
        await sleep(10);
    }
}
```

`life.signal` 是 getter，返回 `AbortSignal.any([actor 级 signal, 当前这次调用的 signal])`。方法里读到的任何时刻都是准的，而且**它区分不出**取消来自哪里 —— 也不需要。

这就是 `src/index.ts` 里比「纯单进程 actor」多出来的那 12 行。没有它，远程取消只能做到「客户端不等了」，对面还在跑（实测：客户端 102ms 返回，服务端会跑满 3000ms）。

## actor 级 vs 调用级

两种 abort 的语义不同，别混：

|                             | 谁触发                 | 之后                                     |
| --------------------------- | ---------------------- | ---------------------------------------- |
| actor 级（`close()`）       | 宿主关掉这个 actor     | 正在跑的停、新调用被拒                   |
| 调用级（`$call` 的 signal） | 某一次调用的调用方放弃 | 正在跑的停、**actor 还活着**，能接下一单 |

04 节演示前者，06 节演示后者落进同一个 `life.signal`。

## 什么时候别桥

- 只有一个调用方、一条连接、不会断、不需要取消 —— 20 行帧转发就够
- 只是想让两个同进程模块解耦 —— 那是依赖注入的事，不是跨进程
- 想共享状态而不是共享操作 —— 那不是 actor，是数据库

## 反过来：状态该放在哪一头

`pkgs.ts/room/src/room.ts` 的头部写着「零 task / 零 IO，水位只是内存」。这种纯逻辑包要变成 actor（有私有状态、要串行），跨进程时的正确形态是：

**状态留在主进程的 actor 里，另一端通过 rpc 调它。** 不是「两端各有一份，然后同步」。

workbench 已经这么做：`pkgs.ts/ui/workbench/src/index.ts` 里 main 侧 `server.use(...)` 挂 handlers、反方向用 `createScopedClient`，一条 electron transport 双向跑。

判断依据很简单：**如果两份状态需要同步，就说明其中一份该消失。**

## 更省事的写法：`cmd` 子路径

上面那张「四个位置」的表里，`api.ts`（契约）和 `server.ts`（转手）其实是纯样板 —— 前者是**第二份真源**，后者每个方法一行。如果愿意让「契约」用 zod 写，这两块可以合成一处：

```ts
import { cmd, actorOf, apiOf, serveActor, createActorClient } from '@diy-agent/actor/cmd';

const makeRoom = (life: Life) => ({
    say: cmd({ input: { who: z.string().min(1) }, output: z.number() }, ({ who }) => {
        seq++;
        return seq;
    }),
});

const room = actorOf(makeRoom); // 本地
serveActor(actorOf(makeRoom), server, 'room'); // 服务端
const remote = createActorClient({
    // 客户端
    api: apiOf(makeRoom),
    client: new ChannelClientBinding(ipcTransport(childChan(child))),
    prefix: 'room',
});

await remote.say({ who: '你' }); // Promise<number>，类型从声明推出来
await remote.slow({ ms: 3000 }, { signal }); // 不用 $call
```

|              | 手写桥（06）                             | `cmd`（08）                           |
| ------------ | ---------------------------------------- | ------------------------------------- |
| 契约         | `api.ts` 36 行，第二份真源               | 0（`apiOf(makeRoom)`）                |
| 服务端转手   | `server.ts` 40 行                        | `serveActor` 一行                     |
| 取消         | `room.$call('slow', [3000], { signal })` | `room.slow({ ms: 3000 }, { signal })` |
| 用户侧总行数 | 297                                      | 146                                   |

**没有换协议**：底下仍然是 `mountService` / `createTypedClient` / transport / cancel 帧，或者说它就是用掉 rpc 已有的东西把上面那两块样板自动生成出来。

### 三个代价

1. **`apiOf()` 会执行 factory**，状态丢掉只取 cmd 定义。所以 factory 的闭包初始化必须无副作用，且不要在 factory 里 `import fs` —— 客户端要 `apiOf`，那个 import 会跟到客户端包里。
2. **入参必须是对象**（`{ ms: z.number() }` 而不是 `ms: number`）。这是换 `(input, opts?)` 与 rpc 同形、从而甩掉 `$call` 的代价。
3. **`serveActor` 里有一处 `as unknown as`**：按字符串键遍历时编译器跟不住键与 handler 的对应。和 06 里 `handlers as never` 同类，只是从范例收进库一次。

### 零依赖还在吗

在，但分成了两个入口：

| 入口                   | 依赖                   | 给谁用                   |
| ---------------------- | ---------------------- | ------------------------ |
| `@diy-agent/actor`     | 无                     | 单进程；或自己写桥       |
| `@diy-agent/actor/cmd` | zod + `@diy-agent/rpc` | 要跨进程、且不想手写契约 |

`import '@diy-agent/actor'` 不会把 zod 和 rpc 拉进来 —— 子路径导出就是为了保住这条。

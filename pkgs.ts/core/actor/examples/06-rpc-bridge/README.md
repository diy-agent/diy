# 06 — 跨进程：actor + 一层 rpc 桥

```bash
node --import tsx pkgs.ts/core/actor/examples/06-rpc-bridge/
```

## 一句话

**actor 不含网络代码。** 跨进程由宿主挑一根管子桥进来 —— 本范例用 `@diy-agent/rpc`，于是断线、超时、错误码、取消帧、CLI 入口全部现成。

## 五个文件，各管一件事

| 文件 | 行数 | 管什么 | 跨进程吗 |
|---|---|---|---|
| `room.ts` | 51 | 业务本体：私有状态 + 方法表 | **完全无关** |
| `api.ts` | 36 | 有哪些方法、入参/出参什么形状 | 契约，两端共享 |
| `ipc.ts` | 60 | node IPC → rpc 的 `EnvelopeTransport` | 只有这里 |
| `server.ts` | 40 | 方法表 → api（一行一个转手） | 桥 |
| `index.ts` | 110 | 起子进程、调远端、演示四件事 | 客户端 |

`room.ts` 一个字都不改就能跑 —— 它和第 02 节那个 room 是同一类东西。这是本范例要证明的第一件事。

## 走一遍

### 一、远端调用

```ts
const room = createScopedClient({
    api: roomApi,
    client: new ChannelClientBinding(ipcTransport(childChan(child))),
    prefix: 'room',
});

await room.say({ args: ['你', '一'] });   // 跑在子进程里
```

### 二、串行是指 actor 的串行

三次并发发出去，seq 仍然是连号 —— 对面只有一个 actor 实例、一条链。**桥接不改语义**：远端看到的和本地调用完全一样。

### 三、取消穿过进程边界

这是最值得看的一段：

```
客户端 102ms 后抛错：用户按了停止
[子进程] 第 11 次检查时停下
3.4s 后问对面：第 11 次检查时停下
↑ 不是「客户端不等了」，是「对面停了」—— 取消帧真的过去了
```

对面那个方法里写的是 `if (life.signal.aborted)` —— **和 04 节本地取消是同一行**。它不知道自己是被本地 `close()` 取自的，还是被另一个进程的 abort 取消的。

桥这边只有一行的功劳：

```ts
slow: ({ input, signal }) => room.$call('slow', [input.args[0] as number], { signal }),
//                                ↑ rpc 给的 signal，直接转手
```

### 四、错误带码

```
对面 throw → 这边 INTERNAL：发言人不能为空
```

调用方可以按 `code` 分支，不是只能匹配字符串。

## 为什么不用「actor 自带的网络层」

写过一版 `src/net.ts`（192 行，`serve` / `connect` + Proxy 自动转发），删了。理由是它等于**第五种 transport** —— 和 rpc 的 `ws` / `http` / `electron` / `mem` 平行但不兼容，于是：

| | rpc 的 transport | 自建 net 层 |
|---|---|---|
| 复用现有管子 | ws / http / electron 任选 | 每种新连接都要自己写 |
| 超时 | `{ timeout }` 已实现 | 无 |
| 错误码 | `RpcError{ code, details }` | 只有 message 字符串 |
| 断线 | destroy → 全部 abort | 无 |
| 双向调用 | 一条管子 client+server 各挂一个 | 要自己再建反方向 |
| CLI 入口 | 841 行命令树现成 | 无 |

自建那版唯一真优势是**方法表零声明**（`connect<Room>(link)` 从类型推出来，不用写 `api.ts`）。为了这一点丢掉上表全部内容不划算 —— 而「零声明」如果真需要，是给 rpc 加一个类型到 stub 的转换器的事，不是另起一套协议。

## 桥接的唯一代价

`api.ts` 里每个方法要写一条声明，**input 和 output 两条 shape 都必填**，而且位置参数要包成 `{ args: [...] }`。

```ts
const unary = <const T extends Record<string, z.ZodTypeAny>, O = unknown>(
    input: T = {} as T,
    output: z.ZodType<O> = z.unknown() as z.ZodType<O>,
) => RpcSchema.unary({ input, output });

say: unary({ args: z.array(z.unknown()) }),
//          ↑ actor 的 say(who, text) 到了线上变成 { args: [who, text] }
```

两个别扭的地方，都得认：

1. **位置参数要包一层**。这是 rpc「统一入参对象」的约定换来的 —— 它让 options（signal / timeout）有地方放，也让流式调用有统一的 init/ack 结构。
2. **output 也要声明**。写 `z.unknown()` 就是「客户端拿到的返回值是 unknown，自己 cast」（本范例这么做，见 `index.ts` 的 `interface Line`）。写成真 shape 客户端就有类型，但那个 shape 和 `room.ts` 的返回类型是两份真源 —— actor 的方法签名推不到 rpc 的 schema 里。

`z.array(z.unknown())` 等于不校验。想校验就写 `z.tuple([z.string(), z.string()])` —— 那时对面传错类型会在**进方法之前**被拒，这是桥接白送的一层。

## 什么时候真的不需要这层

如果远端只有**一个**调用方、**一条**连接、**不会断**、**不需要取消** —— 自己写 20 行帧转发更快。但凡命中下面任一条，用 rpc：

- 连接会断（窗口重建、网络抖动）
- 调用需要取消（用户点停止）
- 有多个客户端（每个进来一次）
- 想要 CLI 入口

`docs/bridging-rpc.md` 是这套判断的完整版。

# 08 — 声明式：契约与实现分居两文件，类型只推一次

```bash
node --import tsx pkgs.ts/core/actor/examples/08-cmd/
```

## 一句话

**和 rpc 一样把契约、实现分成两个文件，但类型不用手写第二遍。** 06 里 `api.ts` 要手写 36 行 schema、`server.ts` 还要每个方法转手一次；这里 `api.ts` 用 `cmd()` 声明，`impl.ts` 用 `implement()` 绑实现 —— 参数类型、返回类型全部从 `api.ts` 推出来。

底下仍然是 rpc，协议一个字节没改 —— 换掉的是样板，不是协议。

## 三个文件

| 文件      | 谁 import                   | 内容                                                            |
| --------- | --------------------------- | --------------------------------------------------------------- |
| `api.ts`  | 客户端 + 服务端             | `cmd({ input, output })`，零实现                                |
| `impl.ts` | **只有服务端**              | `implement(roomApi, setup, handlers)`，状态和无副作用的实现都在这 |
| `index.ts`| —                           | 演示                                                            |

```ts
// api.ts —— 客户端只能 import 这个
export const roomApi = {
    say: cmd({ input: { who: z.string().min(1), text: z.string() }, output: z.number() }),
};

// impl.ts —— 只有服务端 import 这个
export const makeRoom = implement(
    roomApi,
    () => ({ seq: 0, lines: [] as string[] }),          // setup：一次生命周期一次
    {
        say: ({ who, text }, { state }) => {            // who / text / 返回值类型全是推的
            state.seq++;
            state.lines.push(`${state.seq}. ${who}: ${text}`);
            return state.seq;
        },
    },
);
```

| 用途   | 一行                                                    | 拿到什么                                 |
| ------ | ------------------------------------------------------- | ---------------------------------------- |
| 本地   | `actorOf(makeRoom)`                                     | `room.say({who,text}) → Promise<number>` |
| 服务端 | `serveActor(room, server, 'room')`                      | 挂到管子上                               |
| 客户端 | `createActorClient({ api: roomApi, client, prefix })`   | 同一个 `Promise<number>`                 |

**类型只有一份真源。** 客户端拿到的 `Promise<number>` 是从 `output: z.number()` 推出来的，不是手写 cast，也不是 `unknown`。改 `api.ts` 的出参，两端同时改。

## 为什么必须是两个文件

客户端的 import 图里只能有 `api.ts`。如果把 `cmd()` 和实现写在同一个文件（旧版是 `cmd({ input, output }, run)`），客户端 `import` 契约时 bundler 会顺着 `impl.ts` 的 import 图把整棵依赖树打进去 —— `node:fs`、server-only 依赖、密钥读取，全都跟着走。这不是「可能」，是必然。

分开之后，`impl.ts` 里 `import fs` 完全安全；`setup()` 里有副作用也不要紧 —— **客户端一行实现代码都不执行**（下面的输出证明了这点）。

## 实际输出

```
本地 → 1
本地 → 2
远端 → 1 （类型 number，没 cast）
远端 → [ { seq: 1, text: '1. 你: 三' } ]
取消：103ms 后抛错：用户按了停止
本地直连同一个 actor → 跑完了（3298ms）
取消之后还能继续 → [ { seq: 1, text: '1. 你: 三' } ]
入参被拦在方法之前 → [ { "origin": "string", "code": "too_small", "minimum": 1, "
对面 throw → 炸了

setup 跑了 2 次（本地 actor + 远端 actor，客户端 0 次）
```

最后一行是关键对比：旧写法这里是 **3 次**（本地、远端、`apiOf` 取契约各一次），因为客户端要「跑一遍工厂去取契约」。现在契约是静态的，**客户端 0 次**。

## 类型真的会拦

`impl.ts` 里写错了不用等运行时（这四条是实测的编译错误）：

| 写错什么             | 报错                                                     |
| -------------------- | -------------------------------------------------------- |
| 少实现一个方法       | `TS2739: missing the following properties ... : lines, slow, boom` |
| 参数名写错           | `TS2339: Property 'wrong' does not exist on type '{ who: string; text: string }'` |
| 返回类型错           | `TS2322: Type 'string' is not assignable to type 'number \| Promise<number>'` |
| `state` 上访问不存在的字段 | `TS2339: Property 'nope' does not exist on type '{ seq: number }'` |

## 比 06 省在哪

只比「契约 + 实现 + 转手」这三块（不含演示代码和 transport 装配）：

|            | 06 手写桥                    | 08 cmd                |
| ---------- | ---------------------------- | --------------------- |
| 契约       | `api.ts` 36 行，手写类型     | `api.ts` 19 行        |
| 实现       | `room.ts` 51 行              | `impl.ts` 43 行       |
| 服务端转手 | `server.ts` 40 行（4 处 cast） | `serveActor` 一行   |
| 合计       | **127 行**                   | **62 行 + 一行装配**  |

省的是**手写类型和转手代码**，不是传输代码。

## 取消为什么不用 `$call` 了

06 里写 `room.$call('slow', [3000], { signal })`，因为内核的方法签名是位置参数，塞不进第二个参数。

`cmd` 把入参约束成一个对象，于是方法签名变成 `(input, opts?)` —— 和 rpc 的 `(input, options?)` 同形。signal 直接当第二个参数传：

```ts
await remote.slow({ ms: 3000 }, { signal: ctl.signal });
```

`serveActor` 里那行转手仍然是 `({ input, signal }) => call[k](input, { signal })`，但每个方法只需要一行，不需要为每个方法单独讨论「第几个参数是 signal」。

handler 那侧读 `ctx.signal` —— 它是 **getter**，转发内核的 `life.signal`，所以读到的既是「actor 被 close」也是「这一次调用被取消」。取快照会让跨进程取消失效。

## 三个代价

**1. 两个文件。** 这是换取「客户端不打包实现」的代价，不是可选项；合成一份文件就会把 `node:fs` 拖进客户端包。

**2. 入参必须是对象。** 这是换取 `(input, opts?)` 同形的代价。单个参数的场合要写 `{ ms: z.number() }` 而不是 `ms: number`。

**3. 库里有两处 `as unknown as`**（`implement` 绑 handler、`serveActor` 转手）。按字符串键遍历时编译器跟不住「这个键 → 这个 handler」。和 06 里 `handlers as never` 是同一类问题，只是从范例收进了库里一次。对使用者没有泄漏 —— 传进去和拿到手的都是精确类型。

## 什么时候还是写 06 那种手写桥

- 方法只有两三个，且调用方就在同一个进程里 —— 样板省不下多少
- 想让**方法的签名**在桥上可见（`cmd` 的入参被强制成对象）
- 不想让 `actor` 这个包带上 zod + rpc 依赖 —— 那就只用内核，`import '@diy-agent/actor'` 仍然是零依赖的

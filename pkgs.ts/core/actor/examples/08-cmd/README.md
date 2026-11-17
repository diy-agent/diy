# 08 — 声明式：一条 cmd 管两端

```bash
node --import tsx pkgs.ts/core/actor/examples/08-cmd/
```

## 一句话

**契约和实现合成一处。** 06 里要写两个文件（`room.ts` + `api.ts`），还要在 `server.ts` 里每个方法转手一次；这里写一次 `cmd({ input, output }, run)`，本地方法、rpc 契约、服务端 handler、强类型 client 全部自己出来。

底下仍然是 rpc，协议一个字节没改 —— 换掉的是样板，不是协议。

## 一个文件，四样产出

```ts
const makeRoom = (life: Life) => ({
    say: cmd({ input: { who: z.string().min(1), text: z.string() }, output: z.number() }, ({ who, text }) => {
        /* ... */ return ++seq;
    }),
});
```

| 用途   | 一行                                                                  | 拿到什么                                 |
| ------ | --------------------------------------------------------------------- | ---------------------------------------- |
| 本地   | `actorOf(makeRoom)`                                                   | `room.say({who,text}) → Promise<number>` |
| 服务端 | `serveActor(room, server, 'room')`                                    | 挂到管子上                               |
| 客户端 | `createActorClient({ api: apiOf(makeRoom), client, prefix: 'room' })` | 同一个 `Promise<number>`                 |
| 契约   | `apiOf(makeRoom)`                                                     | rpc 的 `ProcedureMeta` 树                |

**类型只有一份真源。** 客户端拿到的 `Promise<number>` 是从 `output: z.number()` 推出来的，不是手写 cast，也不是 `unknown`。改 `cmd` 的出参，两端同时改。

## 实际输出

```
本地 → 1
本地 → 2
远端 → 1 （类型 number，没 cast）
远端 → [ { seq: 1, text: '1. 你: 三' } ]
取消：102ms 后抛错：用户按了停止
本地直连同一个 actor → 跑完了（3229ms）
取消之后还能继续 → [ { seq: 1, text: '1. 你: 三' } ]
入参被拦在方法之前 → [ { "origin": "string", "code": "too_small", "minimum": 1, "
对面 throw → 炸了

factory 被调用 3 次（本地 1 + 远端 actor 1 + apiOf 1）—— 所以必须无副作用
```

## 比 06 省在哪

|            | 06 手写桥                           | 08 cmd            |
| ---------- | ----------------------------------- | ----------------- |
| 契约       | `api.ts` 36 行，**第二份真源**      | 0                 |
| 服务端转手 | `server.ts` 40 行（4 行 `as` cast） | `serveActor` 一行 |
| 客户端装配 | 5 行                                | 5 行              |
| 用户侧合计 | 297 行                              | 146 行            |

省的是**转手代码**，不是传输代码。

## 取消为什么不用 `$call` 了

06 里写 `room.$call('slow', [3000], { signal })`，因为内核的方法签名是位置参数，塞不进第二个参数。

`cmd` 把入参约束成一个对象，于是方法签名变成 `(input, opts?)` —— 和 rpc 的 `(input, options?)` 同形。signal 直接当第二个参数传：

```ts
await remote.slow({ ms: 3000 }, { signal: ctl.signal });
```

`serveActor` 里那行转手仍然是 `({ input, signal }) => call[k](input, { signal })`，但每个方法只需要一行，不需要为每个方法单独讨论「第几个参数是 signal」。

## 三个代价

**1. factory 会被跑多次。** `apiOf(makeRoom)` 为了取契约也要跑一遍 factory，所以上面的输出里是 3 次（本地 actor、远端 actor、apiOf 各一次）。这意味着 factory 的**闭包初始化必须无副作用** —— 和 rpc 的 `api.ts` 是同一纪律，只是从两个文件收敛成一个工厂。

也意味着：**别在 factory 里 `import fs`**。客户端要 `apiOf(makeRoom)`，那个 import 会跟着打进客户端包。

**2. 入参必须是对象。** 这是换取 `(input, opts?)` 同形的代价。单个参数的场合要写 `{ ms: z.number() }` 而不是 `ms: number`。

**3. `serveActor` 里有一处 `as unknown as`。** 按字符串键遍历时编译器跟不住「这个键 → 这个 handler」。和 06 里 `handlers as never` 是同一类问题，只是从范例收进了库里一次。对使用者没有泄漏。

## 什么时候还是写 06 那种手写桥

- 方法只有两三个，且调用方就在同一个进程里 —— 样板省不下多少
- 想让**方法的签名**在桥上可见（`cmd` 的入参被强制成对象）
- 不想让 `actor` 这个包带上 zod + rpc 依赖 —— 那就只用内核，`import '@diy-agent/actor'` 仍然是零依赖的

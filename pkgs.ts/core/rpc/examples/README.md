# rpc 用法示例

**`service/` 是推荐写法**（`defineService` + 生成器）。`raw/` 是底层直用，
留作「为什么 `defineService` 存在」的对照。

```
examples/
├── service/    ← 推荐：一个例子一个目录，自带 api.ts + 生成的类型 + 可跑脚本
│   ├── 01-basic/     { src/api.ts, src/gen/*.d.ts, run.ts }
│   ├── 02-stream/    同构
│   └── 03-cancel/    同构
├── raw/        ← 底层：binding.on(meta, handler) + createTypedClient 直用
│   ├── 01-basic.ts
│   ├── 02-runtime-validation.ts
│   ├── 03-stream.ts
│   └── 04-cancel.ts
（原来这里有个 05-cli.ts，已拆成 `cli/` 整个目录，见下）
└── cli/        ← CLI（`@diy-agent/rpc/cli`）：同一棵树变成命令，逐个可跑
    ├── 01-single-module/    一个模块 → 一棵命令树
    ├── 02-multi-module-root/ 多模块合并成同一个根命令（diy 的形态）
    ├── 03-global-options/   全局选项表：声明/解析/help 同源
    └── 04-root-pitfalls/    根命令的四个坑（rpcPrefix / 多一层 / cliRootPath）
```

## 推荐写法（`service/`）—— 一个目录一个例子

每个目录都是**自给自足**的：

```
service/01-basic/
├── src/api.ts                  ← 手写，唯一真源（生成器的扫描约定）
├── src/gen/api.generated.d.ts  ← 生成（别手改）
└── run.ts                      ← 可执行
```

跑：

```bash
npx tsx pkgs.ts/core/rpc/examples/service/01-basic/run.ts
# 2 + 3 = 5
# version = 1.0.0
```

| 目录 | 演示 | 实测输出 |
|---|---|---|
| `01-basic` | 定义 → bind → use | `2 + 3 = 5` / `version = 1.0.0` |
| `02-stream` | 服务端流（`serverStream`）| 3 块逐条到达 |
| `03-cancel` | 取消传到服务端 | `服务端观察到 abort: true` |

**目录结构和真实包同构**（`<pkg>/src/api.ts`）—— 照着建包，生成器直接能扫到。

## 底层写法（`raw/`）

直接用 `binding.on(meta, handler)` + `createTypedClient`，不经 `defineService`。

```bash
npx tsx pkgs.ts/core/rpc/examples/raw/01-basic.ts
```

**什么时候看它**：
- 想知道 `defineService.bind` 内部做了什么
- 测传输 / 协议层行为（`test/raw/` 也在这个抽象层）
- 排查「是不是 `defineService` 这层的问题」

**日常开发不看它** —— 动态泛型可理解性差，这也是 `defineService` 存在的理由。

## 五个最容易踩的点

**① `input` 是对象，永不摊平**

```ts
await math.math.add({ a: 2, b: 3 });   // ✓
await math.math.add(2, 3);             // ✗
```

tRPC / gRPC / JSON-RPC / AWS SDK 全都这样。理由：加字段不破坏老客户端、可选参数不用占位、
日志可读、CLI 能生成具名参数。

**② 空 input 也要传 `{}`**

```ts
version: RpcSchema.unary({ input: {}, output: z.string() })
await c.math.version({});    // 不能写 version()，zod 会拒 undefined
```

**③ `serverStream` 是 async 方法**

```ts
const stream = await c.job.progress({ n: 3 });   // ← 先 await 拿句柄
for await (const x of stream) { ... }
```

直接 `for await (const x of c.job.progress(...))` 会拿到 Promise，报「不是 async iterable」。

**④ handler 收到的是 `{ input, signal }`**

```ts
mathService.bind(server, {
    math: { add: ({ input }) => input.a + input.b },
    //     ^^^^^^^^^^^^^^^^^^^^^^^ 不是 (a, b)
});
```

**⑤ 服务端要自己检查 `signal`**

框架**不会**强杀你的 `await`。见 `service/03-cancel/src/api.ts`。

## 客户端 vs 服务端签名

```ts
// 客户端：一定 Promise，options 可选（取消 / 超时）
add(input: { a: number; b: number }, options?: RpcCallOptions): Promise<number>;

// 服务端：允许同步返回，多一个 signal
add(opts: { input: { a: number; b: number }; signal: AbortSignal }): number | Promise<number>;
```

同一份 `output: z.number()` 在两端契约方向不同 —— 这就是生成器出两组接口的原因。

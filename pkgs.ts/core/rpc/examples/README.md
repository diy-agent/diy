# rpc 用法示例

每个文件都能直接跑：

```bash
npx tsx pkgs.ts/core/rpc/examples/01-basic.ts
```

| 文件 | 演示什么 | 跑出来的样子 |
|---|---|---|
| `01-basic.ts` | 最小可用：定义 → bind → use | `2 + 3 = 5` |
| `02-runtime-validation.ts` | zod 在**运行时**把守 wire 形状 | 三种非法输入全被拦下 |
| `03-stream.ts` | 服务端流（`serverStream`）| 逐块收到的进度 |
| `04-cancel.ts` | 取消传到服务端（`signal.aborted`）| 客户端取消，服务端观察到 |
| `05-cli.ts` | 同一份 schema 变命令行 | schema 就绪说明（CLI 用法在注释里）|
| `06-generated-types.ts` | 生成物（`src/gen/*.d.ts`）怎么用 | 类型层面的示例（不运行）|

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
list: RpcSchema.unary({ input: {}, output: ... })
await c.list({});    // 不能写 list()，zod 会拒 undefined
```

**③ `serverStream` 是 async 方法**

```ts
const stream = await c.job.progress({ n: 3 });   // ← 先 await 拿句柄
for await (const x of stream) { ... }
```

直接 `for await (const x of c.job.progress(...))` 会拿到 Promise，报「不是 async iterable」。

**④ handler 收到的是 `{ input, signal }`**

```ts
service.bind(server, {
    math: { add: ({ input }) => input.a + input.b },
    //     ^^^^^^^^^^^^^^^^^^^^^^^ 不是 (a, b)
});
```

**⑤ 服务端要自己检查 `signal`**

框架**不会**强杀你的 `await`：

```ts
slow: async ({ input, signal }) => {
    await new Promise((resolve) => {
        const t = setTimeout(resolve, input.ms);
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
}
```

## 客户端 vs 服务端签名

```ts
// 客户端：一定 Promise，options 可选（取消 / 超时）
add(input: { a: number; b: number }, options?: RpcCallOptions): Promise<number>;

// 服务端：允许同步返回，多一个 signal
add(opts: { input: { a: number; b: number }; signal: AbortSignal }): number | Promise<number>;
```

同一份 `output: z.number()` 在两端契约方向不同 —— 这就是生成器出两组接口的原因。

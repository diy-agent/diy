# @diy-agent/rpc

声明式 RPC：zod schema 定 wire 形状，`defineService` 把它变成**模块化的 API 单元**，
两端各拿一半（服务端 `bind`，客户端 `use`）。

## 快速上手

```ts
// ① 模块里（<pkg>/src/api.ts）
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const workbenchRoutes = RpcSchema.router({
    page: RpcSchema.router({
        list: RpcSchema.unary({ input: {}, output: z.array(pageInfoSchema) }),
        invoke: RpcSchema.unary({
            input: { pageId: z.string(), method: z.string(), args: z.unknown().optional() },
            output: z.unknown(),
        }),
    }),
});

export const workbenchService = defineService({
    name: "diy.ui.workbench",     // ← 跨进程契约，改名 = 老客户端全挂
    api: workbenchRoutes,
});
```

```ts
// ② 服务端
workbenchService.bind(server, {
    page: {
        list: async () => listPages(),
        invoke: async ({ input }) => invoke(input.pageId, input.method, input.args),
    },
});

// ③ 客户端（只拿这个模块）
const wb = workbenchService.use(client);
await wb.page.list({});
```

## 开发一个 API 的完整步骤

**这一步比以前多了「生成」一环**，但每一步都有它存在的理由。

### 1. 在 `<pkg>/src/api.ts` 里写 schema

```ts
export const myRoutes = RpcSchema.router({
    task: RpcSchema.router({
        get: RpcSchema.unary({
            input: { uri: z.string() },
            output: TaskSchema,
            desc: "按 uri 取一个任务",
        }),
    }),
});

export const myService = defineService({ name: "diy.task", api: myRoutes });
```

**文件名必须是 `api.ts`** —— `gen-service-types` 按这个约定扫（`<pkg>/src/api.ts`）。

### 2. 跑生成器

```bash
node_modules/.bin/tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts
```

产物：`<pkg>/src/gen/api.generated.d.ts`

```ts
/** Task 的客户端形状 */
export interface TaskClient {
    task: {
        /** 按 uri 取一个任务 */
        get(input: { uri: string }, options?: RpcCallOptions): Promise<Task>;
    };
}
```

**为什么要生成**：`TypedClient<T>` 的类型是 Proxy 下钻的条件类型，IDE 里点进去是一堆中间类型。
生成物把它摊平成接口，读代码 / 看报错都直接。

### 3. 服务端 `bind`

```ts
myService.bind(server, {
    task: {
        get: async ({ input }) => loadTask(input.uri),
    },
});
```

**handlers 的形状 = api 树同构** —— 少写一个方法是**编译期错误**（不是启动时才发现某个 rpc 没人接）。
handler 签名是 `({ input, signal }) => T | Promise<T>`。

### 4. 客户端 `use`

```ts
const task = myService.use(client);
await task.task.get({ uri: "projects/4/tasks/87" });
```

### 5. 提交时带上生成物

```bash
git add <pkg>/src/api.ts <pkg>/src/gen/api.generated.d.ts
```

**生成物必须进 git**（`.gitignore` 已对 `src/gen/` 开例外）：
- 消费方 clone 后没有类型
- `--check` 永远报过期（磁盘上根本没有文件可比）

## 改了现有 API 之后

```bash
# 1. 改 schema（加字段 / 改类型 / 改 desc）
# 2. 重新生成（必做，否则 check 会红）
node_modules/.bin/tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts
# 3. 跑 check（会校验生成物是否最新）
./sha.sh check
```

**忘了第 2 步会怎样**：`./sha.sh check` 会红（`gen-service-types --check` 已接进全量检查）。
这是**故意**的 —— 生成物用旧的话，类型看着在、其实和实现不一致，比没有类型更危险。

## 命名策略

```ts
renderServiceTypes("Task", api, { naming: "none" })   // 默认：全内联
```

| 档 | 效果 |
|---|---|
| `none`（默认）| 全内联 —— 一屏看全，不用跳转 |
| `all` | IO + 子接口全具名 —— 报错只显示 `TaskGetInput` |
| `auto` | 标量内联、对象具名（主流做法：协议层具名、查询结果内联）|

**选哪个是口味不是能力**。默认取最简的一档，需要时一行配置切回来。

## 常见坑

**① 空 input 调用要传 `{}`**

```ts
list: RpcSchema.unary({ input: {}, output: ... })
await wb.page.list({});    // ← 不能写 list()，zod 会拒 undefined
```

**② 模块名 / 方法路径是跨进程契约**

```ts
defineService({ name: "diy.ui.workbench", ... })
//                    ^^^^^^^^^^^^^^^^ 改名 = 老客户端全挂（同 protobuf 的字段号）
```

**③ `input` 永远是对象，不摊平**

```ts
invoke({ pageId: "x", method: "y" })    // ✓
invoke("x", "y")                        // ✗ 永远不这么设计
```

调研过 tRPC / gRPC / GraphQL / JSON-RPC / AWS SDK / Stripe / Prisma —— **全都是对象**。
理由：加字段不破坏老客户端、可选参数不用占位、日志可读、CLI 能生成具名参数。

**④ 同一个 routes 别导出两次**

```ts
export const myRoutes = RpcSchema.router({...});
export const myService = defineService({ api: myRoutes });   // ← 指向同一棵树
```

生成器按**对象身份**去重，两者只生成一份。但如果两棵**不同**的树有同名路径，会撞车。

## 分层

```
RouterSchema.router(...)       纯数据：一棵 procedure 树
  ↓ defineService
Service { name, api, bind, use }   模块单元：名字 + 两端入口
  ↓ renderServiceTypes
*.generated.d.ts               派生类型：给人读的接口
```

**`RpcSchema.router` 只是容器**，不注册、不绑定。它的问题从来不是「是函数」，而是
`router()` 里 `_assignNames` 把「树里的路径」写进 `meta.name` —— 所以树必须一次组装完。
`defineService` 是在它之上加一层名字，不改变这一点。

## 测试

```bash
cd pkgs.ts/core/rpc && npx vitest run       # 241 条
```

| 文件 | 覆盖 |
|---|---|
| `test/service.test.ts` | `bind` / `use` / 前缀 / 越界 / 缺 handler |
| `test/service-gen.test.ts` | `zodToTs` 各构造 / 三种命名策略 |
| `test/binding.test.ts` | 四种 stream mode × 各传输 |
| `test/intent.cancel.test.ts` | 取消传播（102 条）|

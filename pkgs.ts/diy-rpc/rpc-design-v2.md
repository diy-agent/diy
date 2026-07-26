# RPC 设计 V2 — 三形态分析

## 角色

```
  定义 (Meta)          注册 (Impl)          使用 (Client)
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ defineUnary  │   │ rpcUnary     │   │ createClient │
 │ defineServer │ ─▶│ rpcServer    │   │ 包装 meta    │
 │ defineClient │   │ rpcClient    │   │ 生成调用代码  │
 │ defineBidi   │   │ rpcBidi      │   │              │
 └──────────────┘   └──────────────┘   └──────────────┘
        ▲                   ▲
        │                   │
  共享给 client        server 端用
  和 codegen          （meta + call + ctx）
```

---

## 形态 1：Meta 层（半完成态）

```ts
// pkgs.ts/diy-desktop2/src/main/services/api-def.ts
// 可被 client import，无服务器端依赖

import { z } from 'zod';
import { defineUnary, defineServerStream } from '@diy/rpc';

export const apiDef = {
  task: {
    create: defineUnary({
      input: {
        title: z.string().min(1).max(200),
        subject: z.string(),
        parent: z.string().optional(),
      },
      output: z.object({
        status: z.string(),
        data: z.object({ uri: z.string() }),
      }),
    }),

    list: defineUnary({
      input: { subject: z.string().optional() },
      output: z.object({
        status: z.string(),
        data: z.object({ tasks: z.array(z.any()) }),
      }),
    }),

    show: defineUnary({
      input: { uri: z.string() },
      output: z.object({
        status: z.string(),
        data: z.any(),
      }).or(z.object({
        status: z.string(),
        msg: z.string(),
      })),
    }),
  },

  agent: {
    chat: defineServerStream({
      input: {
        model: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
      },
      output: z.string(),  // stream yield 的每个 chunk 类型
    }),
  },
} as const;

// 导出类型供 client 端推断
export type ApiDef = typeof apiDef;
```

---

## 形态 2：Impl 层（完整态）— server 端注册

```ts
// pkgs.ts/diy-desktop2/src/main/services/api-impl.ts
// server 端注册 call，挂载实际实现

import { rpcUnary, rpcServerStream } from '@diy/rpc';
import { apiDef } from './api-def';
import * as task from '../core/task';
import * as state from '../core/state';

// 方式 A：保持 meta 不变，独立注册（你提到的方式）
// server.on(metaNode, handler) — handler 类型从 meta 推导
//
// 其中 apiDef.task.create 本身是 ProcedureMeta 对象，
// server.on() 用它的类型信息给 handler 提供完整类型提示

server.on(apiDef.task.create, async ({ input }) => {
  return { status: 'ok', data: { uri: task.createTask(input as any) } };
});

server.on(apiDef.task.list, async ({ input }) => {
  return { status: 'ok', data: { tasks: task.listTasks(input.subject) } };
});

server.on(apiDef.agent.chat, async function* ({ input }) {
  const client = await getAgentClient();
  for await (const delta of client.streamChat(input.model, input.messages)) {
    yield delta;
  }
});

// 方式 B：如果需要额外的 ctx 处理（用户提到 server 需要 ctx）
// 可能通过一个转换步骤

const handleTaskCreate = withContext(apiDef.task.create, async ({ input, ctx }) => {
  // ctx 是 server 端环境，比如 db 连接
  return { status: 'ok', data: { uri: ctx.task.create(input) } };
});
server.on(handleTaskCreate);
```

---

## 形态 3：Client 层 — 调用端

```ts
// client 直接 import api-def，不碰 impl
import { createClient } from '@diy/rpc';
import { apiDef } from './api-def';
import type { ApiDef } from './api-def';

const transport = new ElectronRendererTransport();

// 用 meta 实例化 client
const client = createClient<typeof apiDef>(transport, apiDef);
//             ^^^^^^^^^^^^^^^^^^ 跟当前一样 — createClient 只读 meta，不需要 call

// 调用时类型安全
const result = await client.task.create({ title: 'xxx', subject: 'yyy' });
// result: { status: string; data: { uri: string } }

const msgs = await client.agent.chat({ model: 'llama', messages: [...] });
for await (const chunk of msgs) {
  console.log(chunk); // string
}
```

---

## 关键观察

### 1. `router()` 是否有必要？

当前 `router({...})` 只是 identity，但需要它推导 `Router` 类型。如果用 `as const` + 直接对象字面量，类型系统可以不需要 `router()` 包装：

```ts
// 无 router()
export const apiDef = {
  task: { create: defineUnary({...}) }
} as const;

// router() 只在需要 buildRouteTree/flattenRouter 时必要
// — 但 createClient 内部自己做 flatten，不需要用户调 router()
```

去掉 `router()` 的代价是少一层类型约束，但 `defineUnary` 返回 `ProcedureMeta` 类型已经够用。

### 2. `ProcedureMeta` 与 `ProcedureDef` 的关系

```
ProcedureMeta: 
  _type, _input, _output, _chunkIn, _chunkOut, _streamMode
  inputSchema, outputSchema, chunkInSchema, chunkOutSchema
  summary, description, cliDesc

ProcedureDef extends ProcedureMeta:
  call
  ctx  // 可能
```

`isProcedure(x)` → `x._type === 'procedure'` 对两者都 true。

### 3. `server.on(metaNode, handler)` 的类型推导

需要 `server.on` 从 `ProcedureMeta` 的类型参数推导 handler 签名：

```ts
// server.on 的签名大致是：
on<TIn, TOut, TChIn, TChOut, TMode>(
  def: ProcedureMeta<TIn, TOut, TChIn, TChOut, TMode>,
  handler: HandlerFor<TIn, TOut, TChIn, TChOut, TMode>,
): void;

// HandlerFor 根据 TMode 分派：
// 'unary'   → (opts: { input: TIn }) => TOut | Promise<TOut>
// 'server'  → (opts: { input: TIn }) => AsyncGenerator<TOut>
// 'client'  → (opts: { input: TIn; stream: StreamHandle<TChIn> }) => TOut | Promise<TOut>
// 'bidi'    → (opts: { input: TIn; stream: StreamHandle<TChIn> }) => AsyncGenerator<TOut>
```

如果需要 `ctx`（server 端环境如 db、state），加一层包装：

```ts
server.withContext(ctx).on(apiDef.task.create, async ({ input }) => {
  // ctx 从 server 注入
});
```

或 `server.on` 的第二参数是回调，但 `ctx` 是 server 构造时注入的隐式环境。

### 4. 与未来 codegen 的关系

codegen 产物 ≈ 当前手动写的 meta 代码 + 类型安全的 Client 类：

```ts
// codegen 生成：
export const apiDef = {
  task: {
    create: defineUnary({
      input: { title: z.string(), ... },
      output: z.object({ status: z.string(), ... }),
    }),
  },
} as const;

// + 一个非 Proxy 的 Client 类
export class Client {
  constructor(transport: Transport);
  task: {
    create(input: { title: string }): Promise<{ status: string; data: {...} }>;
  };
}
```

手动写和 codegen 产出的 meta 层外观一致，只是 codegen 多产出一个 Client 类（无 Proxy 开销）。

---

## 待定项

| 项 | 问题 |
|----|------|
| `router()` 包装 | 需要还是不要？去掉后类型推导会怎样 |
| `ProcedureDef` 的 ctx | ctx 是定义在 def 级别还是 server 级别注入？ |
| `server.on()` 的 `withContext` | 是否需要？还是 server 构造时注入 ctx，handler 自动获得 |
| stream 的 output schema | serverStream 的 yield type = output schema 的 element？还是 output 单独声明？ |

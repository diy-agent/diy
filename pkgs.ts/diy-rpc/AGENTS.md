# @diy/rpc — 纯内核包

## 三层架构

```
@diy/rpc                         ← 第1-3层核心（纯 TypeScript，零外部依赖）
@diy/rpc-transport               ← 传输实现聚合（ws、http2、未来 stdio 等）
@diy/rpc-transport-electron      ← Electron IPC 传输实现
```

## 本包包含

```
src/
├── transport/         ← 第1+2层：传输层抽象 + Raw API
│   ├── types.ts       ── Transport 接口 + Envelope 信封类型（零外部依赖）
│   ├── async-queue.ts ── 可取消异步队列
│   ├── client.ts      ── 第2层：Client 类（invoke/stream/send）
│   ├── server.ts      ── 第2层：Server 类（消息分发 + 流管理）
│   └── transport-logger.ts
├── rpc/               ← 第3层：声明式 RPC
│   ├── index.ts       ── rpc.unary/serverStream/clientStream/bidiStream
│   │                     + router() + createHandler() + createClient()
│   └── cli-rpc/       ── CLI-RPC 桥接
└── index.ts           ── barrel 导出
```

## 三层职责

| 层 | 角色 | 使用方 |
|----|------|--------|
| **1️⃣ Transport** (`types.ts`) | `Transport` 接口 + `Envelope` 信封协议 | 第2层 |
| **2️⃣ Raw API** (`client.ts` `server.ts`) | 协议层封装。`Client.invoke/stream`、`Server.onUnary/onServerStream` | 第3层（仅入口组装代码） |
| **3️⃣ RPC** (`rpc/index.ts`) | 声明式 Procedure。`rpc.unary()` `router()` `createHandler()` `createClient()` | **应用程序代码** |

## 使用规则

- **应用程序代码只使用第3层 RPC**
- **`Client` / `Server`（第2层）只在入口组装代码中**：传给 `createHandler()`/`createClient()`
- **传输实现不在本包**：在 `@diy/rpc-transport` 和 `@diy/rpc-transport-electron` 中

## 浏览器安全

本包是纯 TypeScript，零 Node.js / Electron / 原生模块依赖：
- 唯一外部依赖 `zod`（纯 JS，浏览器安全）
- 所有 import 都是相对路径或 `zod`
- 构建时通过 `check:browser` 脚本验证（扫描 `node:`/`fs`/`path`/`electron` 等 import）
- `sideEffects: false` — 允许 bundler 安全 tree-shake

警告：如果新增依赖或模块，务必先确认它不引入 Node/Electron 特有 API。
跑 `npm run check:browser` 验证。

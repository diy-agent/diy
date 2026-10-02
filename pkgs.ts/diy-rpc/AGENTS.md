# @diy/rpc — 纯内核包

> 全仓契约见**仓库根 `AGENTS.md`**。本包提供 RPC 协议与传输抽象。

## find — 包内定位

- `find.l1` — `src/transport/types.ts` 第 1 层：`Transport` 接口 + `Envelope` 信封协议（零外部依赖）
- `find.l2` — `src/transport/client.ts` / `server.ts` 第 2 层 Raw API：`Client.invoke/stream/send`、`Server.onUnary/onServerStream`
- `find.l3` — `src/rpc/index.ts` 第 3 层声明式 RPC：`rpc.unary/serverStream/clientStream/bidiStream` + `router()` + `createHandler()` + `createClient()`
- `find.cli-bridge` — `src/rpc/cli-rpc/` CLI-RPC 桥接
- `find.transport-impl` — 传输实现**不在本包**：在 `@diy/rpc-transport` / `@diy/rpc-transport-electron`

## rule — 硬约束

- `rule.layer` — **应用程序代码只用第 3 层**；`Client`/`Server`（第 2 层）只在入口组装代码里出现
- `rule.browser` — 本包**纯 TypeScript，零 Node / Electron / 原生模块依赖**（唯一外部依赖 `zod`）。新增依赖或模块前先确认浏览器安全，跑 `./sha.sh check-browser` 验证
- `rule.side-effects` — `sideEffects: false`，允许 bundler 安全 tree-shake

---
desc: diy-rpc 包内定位：核 / 传输（含浏览器）/ CLI 桥 / 发布形态（@diy-agent/rpc 协议内核）
updated: 2026-11-22
---

## cli

`src/cli/` CLI 桥：`_parser.ts` 在**调用方**进程读 stdin / `*-file` 选项（handler 跑在被调的 app 进程，fd 0 与 cwd 都不是调用方的）

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:10）

## core

`src/core/` 平台无关核：

- `rpc.ts`（`RpcSchema`：`group` / `unary` / `serverStream` / `clientStream` / `bidi` + `createTypedClient`）
- `meta.ts`（过程元数据 + zod 桥）· `typed-client.ts`
- `server-binding.ts`（`use({prefix,api,handlers})` / `_on`）· `channel-*.ts`（信封绑定）· `mem.ts`（内存传输对）
- `scope.ts`（`mountService` / `createScopedClient` —— 前缀归使用方）· `service.ts`（`HandlersOf` + **兼容层 `defineService`**，已标 deprecated）
- `error.ts` · `types.ts` · `_tree.ts` / `_async-queue.ts` / `_cli-meta.ts`（内部原语）

**`router()` / `createHandler()` / `createClient()` 已不存在**（2026-11 被 `group` + `use` + `createTypedClient` 取代）。

## entry

`src/index.ts` 根入口（副作用加载 `core/_cli-meta` 的 zod 补丁，再全量 re-export `core`）；子路径入口见 `package.json` 的 `exports`：`./http` `./ws` `./ws/browser` `./electron/main` `./electron/renderer` `./cli`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:7）

## publish

发布形态：`tsconfig.build.json`（NodeNext + emit 到 `dist/`）· 分发脚本 `scripts/npm-publish.mjs`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:11）

## transport

`src/transport/` 传输实现：

| 入口 | 实现 | 浏览器 |
|---|---|---|
| `./http` | `node:http2`（h2c） | ❌（浏览器不支持 h2c） |
| `./ws` | `ws` 包 socket（Node） | — |
| `./ws/browser` | `connectWs` / `wsLikeOf`：浏览器 `WebSocket` → `WsLike` | ✅ |
| `./electron/*` | IPC | — |
| `./cli` | 进程内 | — |

`ws/{types,transport}.ts` **不依赖 Node**，Node 与浏览器共用；浏览器只是多一层形状适配
（`addEventListener → on`、强制 `binaryType='arraybuffer'`）。这条路径被
`tsconfig.browser.json` 覆盖（见 `rpc.rule#browser`）。

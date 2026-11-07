---
desc: diy-rpc 包内定位：核 / 传输 / CLI 桥 / 发布形态（@diy-agent/rpc 协议内核）
updated: 2026-10-23
---

## cli

`src/cli/` CLI 桥：`_parser.ts` 在**调用方**进程读 stdin / `*-file` 选项（handler 跑在被调的 app 进程，fd 0 与 cwd 都不是调用方的）

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:10）

## core

`src/core/` 平台无关核：`rpc.ts`（声明式 RPC + `router()` / `createHandler()` / `createClient()`）· `meta.ts`（过程元数据 + zod 桥）· `server-binding.ts` / `channel-client-binding.ts` / `channel-server-binding.ts` / `server-binding-core.ts`（绑定层）· `typed-client.ts` · `mem.ts`（内存传输对）· `error.ts` · `types.ts`（`Envelope` 信封）· `_tree.ts` / `_async-queue.ts` / `_cli-meta.ts`（内部原语）

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:8）

## entry

`src/index.ts` 根入口（副作用加载 `core/_cli-meta` 的 zod 补丁，再全量 re-export `core`）；子路径入口见 `package.json` 的 `exports`：`./http` `./ws` `./electron` `./cli`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:7）

## publish

发布形态：`tsconfig.build.json`（NodeNext + emit 到 `dist/`）· 分发脚本 `scripts/npm-publish.mjs`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:11）

## transport

`src/transport/` 传输实现：`http/`（`node:http2`）· `ws/`（`ws` 包只在这里用到）· `electron/`（`ipcMain`/`ipcRenderer`）—— **三者都是宿主专属**，不是浏览器安全层（见 `rpc.rule#browser`）

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:9）

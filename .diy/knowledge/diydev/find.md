---
desc: @diy-agent/dev 包内定位：进程内 RPC 入口 / ref 子模块 / runtime / 两条跑法（dev 命令 CLI）
updated: 2026-10-23
---

## cli

`src/cli/index.ts` 入口：**进程内 RPC**（`createMemTransportPair` + `ChannelServerBinding`），零网络零 Electron —— 只为复用 `@diy-agent/app` 同一套命令解析（zod schema + `cliArg`/`cliOption` → help / did-you-mean）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:7）

## entry

`bin/dev`（跑 `build/prod/cli/index.js` 产物）· `./sha.sh dev <args>`（跑源码，**不 cd**）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:10）

## ref

`src/ref/`：`api.ts`（RPC **纯定义**）· `impl.ts`（handler 绑定）· `git.ts`（git 调用）· `store.ts`（`diy.yaml` / `ref.lock.yaml` 读写 + URL 解析）· `render.ts`（输出）· `progress.ts`；另有 `src/git/`（通用 git 调用层，与 `ref/git.ts` 的 RPC 侧分工）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:8）

## runtime

`src/runtime.ts` 只读 `DIY_HOME`（镜像根 `$DIY_HOME/ref`）

（见 115d5522:pkgs.ts/diy-dev/AGENTS.md:9）

---
desc: diy-rpc 硬约束：ESM 扩展名 / 浏览器安全边界 / 发布流程
updated: 2026-11-22
---

## browser

**内核 + ws 传输必须浏览器安全，其余传输层不承诺**：`tsconfig.browser.json`（`./sha.sh check` 里跑）
的 `include` 是 `src/index.ts` + `src/core/**` + `src/transport/ws/{types,transport,browser,index}.ts`；
**Node 特有 API 只准出现在 `src/transport/http|electron|cli`**（`http-client-binding.ts` 的
`node:http2`、electron 的 `ipcMain`），`src/core/**` 与 `src/transport/ws/**` 一律不许。

判据一句话：**新增文件想进浏览器构建，就必须在 `types: [] + DOM` 下编译通过**；进不了就放
Node 专属目录，不要偷偷 import 进 core。

（见 pkgs.ts/core/rpc/tsconfig.browser.json）

## esm-ext

源码内相对 import/export **必须带 `.js` 扩展名**（指向 `.ts`）：发布构建是 `module: NodeNext`，要求显式扩展名；vite/vitest 会把它映回 `.ts`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:15）

## publish-flow

发布**只走** `./sha.sh publish`（= `tsc -p tsconfig.build.json` + `scripts/npm-publish.mjs`，后者在 `dist/` 生成发行版 package.json 再 `npm publish dist`）。仓内 `package.json` 的 `main`/`exports` 恒指 `src/*.ts` 且留 `private:true`（防手滑护栏）—— **发行 exports 由仓内 exports 推导**，新增子路径入口自动带上，别在脚本里另写一份清单

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:17）

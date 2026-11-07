---
desc: diy-rpc 硬约束：ESM 扩展名 / 浏览器安全边界 / 发布流程
updated: 2026-10-23
---

## browser

**内核必须浏览器安全，传输层不承诺**：`./sha.sh check-browser`（`tsc -p tsconfig.browser.json`）的 `include` 只有 `src/index.ts` + `src/core/**`，`exclude` 掉 `src/cli` 与 `src/transport/**` —— 所以**不要**以为 `./http` / `./electron` 也被这条检查覆盖：`http-client-binding.ts` 真 `import * as http2 from "node:http2"`、`electron/` 真 `import { ipcMain, ipcRenderer } from "electron"`。判据一句话：**Node 特有 API 只准出现在 `src/transport/**` 与 `src/cli/**`，`src/core/**` 一律不许**

（见 e05fa9c3:pkgs.ts/diy-rpc/tsconfig.browser.json:9）

## esm-ext

源码内相对 import/export **必须带 `.js` 扩展名**（指向 `.ts`）：发布构建是 `module: NodeNext`，要求显式扩展名；vite/vitest 会把它映回 `.ts`

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:15）

## publish-flow

发布**只走** `./sha.sh publish`（= `tsc -p tsconfig.build.json` + `scripts/npm-publish.mjs`，后者在 `dist/` 生成发行版 package.json 再 `npm publish dist`）。仓内 `package.json` 的 `main`/`exports` 恒指 `src/*.ts` 且留 `private:true`（防手滑护栏）—— **发行 exports 由仓内 exports 推导**，新增子路径入口自动带上，别在脚本里另写一份清单

（见 e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:17）

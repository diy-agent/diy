---
desc: diy-ui 硬约束：DOM 类型自取 / 浏览器入口不许走根 / 控件层交给 Web Awesome / 发布与 lock
updated: 2026-10-23
---

## browser-entry

**浏览器侧只能走浏览器安全入口，绝不 import 根入口**：根 `@diy-agent/ui`（`src/index.ts`）re-export 了 `providers/pi-tui.js`（Node-only），浏览器打包器一 import 它就把 pi-tui 拖进 bundle。安全入口 = `./browser`（统一入口）或细粒度 `./signal` / `./host` / `./dom` / `./dom-dsl` / `./dom-gen`（`package.json::exports` 实测共 7 个键：根 + 这 6 个）。**禁止 deep-import `node_modules/@diy-agent/ui/...`**（包管理器一换就断）

（见 cdb037fd:pkgs.ts/diy-ui/package.json:1）

## components

**控件层用 Web Awesome**（`wa-*` 自定义元素，框架无关）：diyui 只做声明式结构 + 响应式，交互控件交给 Web Awesome（`html.tag("wa-button", {...})`）。diyui **不依赖** Web Awesome，两者可换

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:18）

## dom-lib

`src/providers/dom*.ts` 靠文件头 `/// <reference lib="dom" />` 自取 DOM 类型；**别把 DOM 加进 `tsconfig.json` 的 `lib`** —— 否则核心层误用 `document` 也不再报错（污染纯 TS 内核）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:16）

## esm-ext

源码内相对 import/export 带 `.js` 扩展名（指向 `.ts`）：`module: NodeNext` 与发布构建都要求显式扩展名。**与 `rpc.rule#esm-ext` 同一条判据**（同一类坑，别在两处各记一版）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:19）

## package-lock

本包是根 npm workspace 成员（`pkgs.ts/*`），**不留自己的 `package-lock.json`**（会与根 lock 打架）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:21）

## publish-flow

发布**只走** `./sha.sh publish`；仓内 `main`/`exports` 恒指 `src/*.ts` 且留 `private:true`（防手滑护栏），**发行 exports 由仓内 exports 推导**、新增子路径入口自动带上（同 `rpc.rule#publish-flow`）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:20）

---
desc: diy-ui 包内定位：核心树形运行时 / 浏览器入口 / HostAdapter / providers / demo 站（@diy-agent/ui 声明式 UI 层）
updated: 2026-10-23
---

## browser

`src/browser.ts`：**浏览器安全统一入口**（`Signal` / `ScopeNode` / `CellHost` / 两个 Scheduler / `GenApp` + `html`），**不含 pi-tui**。其依赖链（signal / scope / cell / scheduler / providers/dom-gen）实测零 pi-tui import

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:8）

## core

`src/` 核心（纯 TS 树形运行时）：`signal.ts`（`Signal<T>`，`@vue/reactivity` shallowRef 的框架无关外观）· `scope.ts`（`ScopeNode`/`ScopeConfig` 树 + 配置向上继承）· `components.ts`（`UIComponent` 三态基类，直接实现 pi-tui `Component`）· `cell.ts`（`CellHost` rerun 块 + staging rerun）· `scheduler.ts`（`ImmediateScheduler`/`PeriodicScheduler`）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:7）

## host

`src/host.ts` `HostAdapter`：provider 与原生 UI 树的子节点同步钩子（core 只认 `ScopeNode` 树，不碰原生节点）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:9）

## providers

`src/providers/`：`pi-tui.ts`（`App`，主线）· `dom.ts` / `dom-dsl.ts` / `dom-gen.ts`（浏览器）；`dom-jsx.ts` 是**未采纳**的实验、**不在 `exports` 里**（别引用、别当可用 API）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:10）

## publish

`tsconfig.build.json`（NodeNext + emit 到 `dist/`）· 分发脚本 `scripts/npm-publish.mjs`（仓根）；npm 名 `@diy-agent/ui`（目录名 `diy-ui`，历史名 `diyui`）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:12）

## web

`web/` Vite demo 站（`./sha.sh web`）；`examples/` 是 tsx 脚本（`./sha.sh examples <名>`）

（见 cdb037fd:pkgs.ts/diy-ui/AGENTS.md:11）

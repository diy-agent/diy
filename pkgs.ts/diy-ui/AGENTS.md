# @diy-agent/ui（目录 `diy-ui`）— 声明式 UI 层

> 全仓契约见**仓库根 `AGENTS.md`**。npm 发布名 `@diy-agent/ui`（发布流程见根 `tool.publish`）；历史名 `diyui`。

## find — 包内定位

- `find.core` — `src/` 核心（纯 TS 树形运行时）：`signal.ts`（`Signal<T>`，`@vue/reactivity` shallowRef 的框架无关外观）· `scope.ts`（`ScopeNode`/`ScopeConfig` 树 + 配置向上继承）· `components.ts`（`UIComponent` 三态基类，直接实现 pi-tui `Component`）· `cell.ts`（`CellHost` rerun 块 + staging rerun）· `scheduler.ts`（`ImmediateScheduler`/`PeriodicScheduler`）
- `find.host` — `src/host.ts` `HostAdapter`：provider 与原生 UI 树的子节点同步钩子（core 只认 `ScopeNode` 树，不碰原生节点）
- `find.providers` — `src/providers/`：`pi-tui.ts`（`App`，主线）· `dom.ts` / `dom-dsl.ts` / `dom-gen.ts`（浏览器）；`dom-jsx.ts` 是**未采纳**的实验，**不在 `exports` 里**
- `find.web` — `web/` Vite demo 站（`./sha.sh web`）；`examples/` 是 tsx 脚本（`./sha.sh examples <名>`）
- `find.publish` — `tsconfig.build.json`（NodeNext + emit 到 `dist/`）· 分发脚本 `../../scripts/npm-publish.mjs`

## rule — 硬约束

- `rule.dom-lib` — `src/providers/dom*.ts` 靠文件头 `/// <reference lib="dom" />` 自取 DOM 类型；**别把 DOM 加进 `tsconfig.json` 的 `lib`**（否则核心层误用 `document` 也不会报错）
- `rule.esm-ext` — 源码内相对 import/export 带 `.js` 扩展名（指向 `.ts`）：`module: NodeNext` 与发布构建都要求显式扩展名
- `rule.publish` — 发布**只走** `./sha.sh publish`；仓内 `main`/`exports` 恒指 `src/*.ts` 且留 `private:true`（防手滑护栏），**发行 exports 由仓内 exports 推导**，新增子路径入口自动带上
- `rule.package-lock` — 本包是根 npm workspace 成员（`pkgs.ts/*`），**不留自己的 `package-lock.json`**（会与根 lock 打架）

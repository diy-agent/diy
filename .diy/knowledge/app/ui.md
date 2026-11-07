---
desc: UI 与前端坑（Solid / 主题 / 虚拟化 / 本地存储）
updated: 2026-10-22
---

## daisyui-drawer

drawer 需渲染 `<input class="drawer-toggle">`，漏了侧栏 `visibility:hidden` 直接消失

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:134）

## grid-fold

**收起 area 时被收起 track 的尺寸要交给邻居**（`shared/grid-layout.ts::resolveLayout` 的 `foldTracks`）。本轴还有弹性轨（fr）时剩余空间天然归它，不必动手；但**拖过线之后**两侧 track 都被写成 px（`layoutStore.setTrackPair` 的口径），此时只把 track 写 0 就是净丢那几百 px ⇒ 网格内容比容器窄、右侧一片死区（任务执行页表现为「左栏任务详情最小化后中栏不铺满」，##348 ⑤）。交接方向按「内容区在左上」：列向右找、行向上找。纯函数回归 `tests/core/grid-layout.test.ts`

**2026-10-23 更正**：拖线不再把 fr 轨写成 px —— 见 `app.ui#layout-track-unit`。本条「拖过线之后两侧 track 都被写成 px」现在只对 **base 全 px** 的轴成立；弹性轨不再被固化，故「收起左栏后中栏不铺满」在那类布局里已不会发生。

## hl-token

CodeMirror 默认**只给 token 挂 class、不上色**：必须配 `HighlightStyle` + `syntaxHighlighting()`。`&light`/`&dark` **只能**用在 `EditorView.baseTheme`，写在 `EditorView.theme` 里是**模块加载期**抛错 → 整个 renderer 白屏

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:135）

## layout-track-unit

**track 的单位是身份，拖线只改尺寸不换单位**：base 声明 px 就写 px（固定栏是合法意图），base 声明 fr 就写 **fr 权重**（`shared/grid-layout.ts::trackPairAfterDrag`，按该轨此刻 px 同比缩放 `w' = w·px'/px`；该轴只有一条弹性轨时权重恒保持原值，别写出 0.85 这种漂移）。反例（2026-10-22 实测，##5 报）：拖完把两侧都写成 px ⇒ 声明为 `1fr` 的中栏被固化成 `1589px`，窗口缩到 984px 时合计 1944px 撑爆容器，右侧发送按钮 `right 1028` 被顶出可视区（`getComputedStyle` 列 = `355px 1589px 0px`）。**归一化不放在 `resolveLayout`** —— `ui layout set --cols 300,624,0` 是显式声明，被归一化会静默失效；拖线才是快照，快照该换算。另两条同族硬约束：① `trackCss` 的 fr 必须写 `minmax(0, <v>fr)`（裸 `1fr` == `minmax(auto,1fr)`，下界是 min-content，一行长内容即撑爆列）；② 拖线起点用 `parseTrackPx(getComputedStyle)`，`minmax` 之后浏览器仍回 px 序列（有单测钉住 —— 变了的表现是「拖不动」而非报错）。回归 `tests/core/grid-layout.test.ts`

## localstorage

**禁止把草稿写 localStorage**（属有损数据，且 serve 与 Electron 各持一份）：草稿 + 插话队列落任务目录 `.diy/drafts.yaml`，会话日志落 `$DIY_HOME/local/<uri 路径>/<key>/`（##379 分层）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:138）

## proc-status

工具/思考行的**状态灯（✓/✗/⊘）与「失败块恒展开」的判据在 `src/renderer_solid/lib/chat-fold.ts`**（`procStatusOf` / `procOpenOf` / `isFailedTool` / `isInterruptedToolBlock`，有单测）；组件 `LocalChatPage.tsx` 只把档位映成 class。**别把判据写回组件私有函数** —— 那样测试全绿而用户看不到 ✗（`status` 是 diy 私有属性，改它 UI 与「用户看得见什么」一起变，##329 的原始形态就是「数据对了、界面没变」）。`live` 由调用方传 main 真值（组件读 store），lib 不读 store

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:132）

## renderer

UI 主线是 `renderer_solid/`（SolidJS）；React 版已删除

## solid-show

Solid 组件函数体里的 `if (props.x) return A; return B;` **对 props 变化不响应**（函数体只执行一次）→ 用 `<Show when=… fallback=…>`。反之，`<Show>` 内组件在 `onCleanup` 里读 `props` 会抛 `Stale read from <Show>` 并中断更新 → 需"卸载前落盘"的副作用放面板级组件

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:117）

## solid-ssr-test

node 下 `solid-js` 解析到 **SSR 构建**（`createEffect` 是空实现、不追踪依赖）⇒ 响应式契约单测必须钉**客户端构建**（`vi.mock("solid-js", () => import("solid-js/dist/solid.js"))` + 类型垫片 `tests/types/solid-client.ts`，该 dist 无 types 映射、而 `check-no-emit.sh` 禁 `tests/**` 下的 `.d.ts`）；范式 `tests/core/session-store.test.ts`（真 store + 假 transport 从订阅真路径喂帧，断言**订阅是否还活着**而非 DOM —— "先 apply 后炸"只看 DOM 看不出来）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:116）

## theme

主题**不得回落 `prefers-color-scheme`**：Playwright 的 `colorScheme` 默认 `"light"`，attach CDP 会覆盖系统外观把界面刷白

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:133）

# diy UI 架构（现行）

> 2026-11-10 定稿。**这一版不再讨论选型** —— 选型结论已经在
> [`docs/plans/2026-11-10-ui-framework-eval.md`](plans/2026-11-10-ui-framework-eval.md) 里（React 19 加权 4.35，
> Solid 4.20，差距在生态与 agent 写码正确率，不在运行时）。本文只写**现在按什么做**、
> **为什么这么分层**、以及**踩过的坑变成的规则**，给后面写 UI 的人（和 agent）照抄。

## 1. 一句话

**React 19 只做投影；状态层与 React 无关；组件层以 headless 原语 + 自有设计令牌为准；UI 与 core 之间只有 rpc。**

## 2. 四层，从上到下

| 层 | 是什么 | 放哪 | 依赖方向 |
|---|---|---|---|
| **页面/装配** | 窗口、preload、index.html、打包入口 | `apps/<app>/`（**只装配，不写业务 UI**） | → UI 包 → core（仅类型） |
| **UI 包** | React 组件、无框架 store、领域 rpc 客户端 | 主仓 `pkgs.ts/ui/chat-page`（= diy2 的 UI 包）；dev 参照实现在 `~/git/diy/_diy/pkgs/dev-ui` | → core **只 import 类型** |
| **外壳** | 窗口与页面宿主、实例注册、单实例锁、CDP、`/ping` | `pkgs.ts/ui/workbench` | ← apps 用，不反向依赖 |
| **core** | 数据与规则（快照、启停、git/fs 编排） | `pkgs/dev-core`、`pkgs.ts/ui/*/api.ts` | 不知道 React 存在 |

参照实现：DeepSeek harness（本机 `~/git-ref/deepseek-harness`）的 `packages/client/{store,ui-slots,ui-renderer}`
就是同一套三层拆分，已在生产验证。

⚠️ 路径注意（##526）：本文 §2 / §5.1 里的 `apps/<app>/`、`pkgs/dev-ui`、`pkgs/dev-core` 描述的是
**dev 启动器**（另一个 checkout：`~/git/diy/_diy`）。主仓 `diy/` 里只有 `apps/chat`，它的 UI 包是
`pkgs.ts/ui/chat-page`（`src/{store.ts,client.ts,renderer-react.tsx,ui/*.tsx,react.css}`）。

### 2.1 UI 包内部的固定三件套

```
<app>-ui/src
├── store.ts      无框架快照仓库：不可变快照 / 整体替换 / 变更广播
├── client.ts     **领域式 rpc 客户端**：方法名与入参形状只在这一个文件里
├── renderer-react.tsx  页面投影（订阅 store；组件只谈业务语义，不写 rpc 字符串）
├── ui/*.tsx      shadcn 组件（源码引入）
├── react.css     tailwind 入口 + M3 令牌桥（@source 由使用方声明）
└── slots.ts      扩展点注册表（只有需要插件 UI 的 app 才有）
```

**组件里不许出现 `invoke("start", …)` 这类字符串方法名** —— 一律走 `client.ts`。理由：core 改协议时
要在**编译期**报错，而不是运行期在某个按钮里静默失败（本轮真踩过：`Unknown method` 只在点开页签时才炸）。

## 3. 组件与视觉

| 关注点 | 现行做法 |
|---|---|
| 行为 / 无障碍 | `@base-ui/react`（headless；Radix 为历史备选） |
| 组件来源 | shadcn 式**源码引入**（组件落自己仓库，密度随手改），不引带固定视觉的成套库 |
| 视觉真源 | **自家 M3 令牌**：`pkgs.ts/ui/design`，由 seed 生成（见 §5.1）；组件库自带调色板一律覆盖 |
| 样式 | Tailwind v4（`@theme inline` 把 `--md-sys-color-*` 映射成 `bg-surface` 这类工具类） |
| 密度 | compact / comfortable / spacious 三档 Token（IDE 类界面缺省 compact） |
| 重活 | Monaco（编辑）、xterm.js（终端）、TanStack Table + Virtual（大表）、dockview（分屏，待 POC） |
| 过渡期可选件 | `@material/web`（M3 控件）、Web Awesome（card/tree/split-panel）——**已引入但不作默认**，只为省掉个别成品件 |

### 3.1 shadcn 怎么接（##526 落地）

- 组件**源码进仓**（`chat-page/src/ui/*.tsx`，`base-nova` = Base UI 变体），不装成套库；
- 需要 `cn()`（`clsx` + `tailwind-merge`）与 tailwind 工具类 —— 构建见 §2.1 的 `react.css`；
- **令牌桥**是唯一定制点：`react.css` 的 `@theme inline` 把 shadcn 的
  `--background / --primary / --border / --ring / --radius-*` 指到 `--md-sys-color-*`，
  组件源码不动就套上 M3；
- 拉新件：`chat-page/components.json` 与 tsconfig `paths`（`@/*` → `./src/*`）已就位，
  `npx shadcn add <件>` 认得出落点（`src/ui/`）与 utils（`@/lib/utils` → `src/lib/utils.ts`）；
- **但 emit 不重写 paths**：生成物里的 `@/...` 必须改回相对 import（`./cn.js`）—— `dist/` 要被
  Node 直接加载（`apps/chat` 打包时 `@diy-agent/*` 是 external），这条##526 的规则仍然成立；
- 本机 npm 12 会拦 CLI 的自动 install（`EALLOWSCRIPTS`）⇒ 依赖手动装（`npm i <包> -w @diy-agent/chat-page`），
  必要时用 `shadcn add <件> --view <路径>` 取源码手落盘；
- shadcn 默认 `h-9 px-4` 是 comfortable 密度，IDE 类界面用 `size="xs"`（h-7）那一档。

> 标注：`@material/web` + Web Awesome 的组合，最初是「Solid / diy-ui 用不了 JSX 生态」时代的折中。
> React 19 已原生支持 custom elements，这条约束消失 —— 新页面**优先** base-ui + 自有组件，
> 需要成品件时再单独引，不要在整页上铺 WC。

## 4. 与 core 的边界

- UI 包对 core **只 import 类型**（`import type … from "@diy-agent/<core>/shared"`，编译后擦除）。
- 唯一的运行时依赖是 schema 类包（如 `dev-fs/api`）——它走 preload 递出的 transport，不经 page 桥。
- 所有读写都过 rpc：page 桥（`page:invoke`）或专用 rpc 服务；UI 不碰 fs / 进程。
- 好处：UI 包可换宿主（HTTP / 进程外插件 / 终端渲染），核心不动。

## 5. 实操经验：这一轮重构踩的坑 → 规则

### 5.1 M3 令牌要**生成**，不要手抄

- `design/src/gen/**` 是**生成物**（`ref-palette.css` / `sys-color.css`），由 `./sha.sh gen` 从 seed 重算，
  `./sha.sh check` 逐字节比对是否过期。
- 用 `MaterialDynamicColors` + `SchemeTonalSpot` 拿**全部 49 个**语义角色；`theme.schemes.*` 只有 29 个，
  缺 `surface-container-*` / `*-fixed` 系列，组件会退回内置灰。
- 目录分层：`gen/`（生成物）· `base/`（M3 规范常量：shape/motion/elevation/typography）· `diy/`（我们自己的覆盖）。
  **别把生成物和自己的 CSS 混在一层**。

### 5.2 Tailwind 与库的分工

- 库里的 CSS **不要内建 `@source`**：它按库文件位置解析，扫不到使用方的组件；`@source` 由使用方声明。
- `@layer` 排序声明只留一处（库入口），重复声明会让排序漂移。
- 自定义 `@utility` 不要覆盖数值间距（`--value(--spacing-*)` 会顶掉 `p-4`）；M3 上游**没有** space token，
  需要间距尺度就自己显式定义 `--spacing-*`，别引用不存在的 `--md-sys-space-*`。

### 5.3 React 的四个硬规则（本轮的 3 次白屏全中）

1. **hook 只能在组件/自定义 hook 里**：写在模块顶层 ⇒ `Cannot read properties of null (reading 'useState')`。
2. **`useSyncExternalStore` 的选择器必须返回稳定引用**：`s?.lines ?? []` 每次新建数组 ⇒ 认为快照一直变 ⇒
   无限重渲染（React error #185）。空数组用模块级常量；派生列表放 `useMemo`。
3. **传给 effect/hook 的函数要 `useCallback`**：内联箭头每次渲染都是新引用 ⇒ effect 反复重跑 ⇒
   `setState` 循环（现象同样是白屏，但报错信息完全不同）。
4. **订阅只在一个地方**：`useStoreSlice(store, selector)` 是唯一桥；业务组件不写 `subscribe`。

### 5.4 构建链（esbuild + tailwind，不用 vite 也能跑）

- JSX：`esbuild --jsx=automatic`（React 19 automatic runtime）。
- 样式：`@tailwindcss/cli` 单独出 CSS —— esbuild 不认 `@import "tailwindcss"` / `@theme`。
- TS 要 `declare module "*.css"`（副作用 import 否则报 TS2882），并把它加进 tsconfig 的 `include`。
- `package.json` 的 `exports` 键必须以 `./` 开头 —— 少一个点，esbuild 直接报「无法解析」。

### 5.5 实例运行空间（dev 与 diy-app 同构）

- **独占粒度 = 数据根**：`app.setPath("userData", <home>/electron_user_data)` 必须在
  `requestSingleInstanceLock()` 与 `whenReady()` **之前**；锁按 userData 分家，天然「一个数据根一个实例」。
- 拿不到锁要打印**为什么 + 下一步**（`lockAdvice()` 区分活实例 / 陈旧锁 / 跨机锁），不要静默退出。
- **CDP 端口不写死**：缺省 `0` 让 Chromium 挑，实际端口从 `<userData>/DevToolsActivePort` 读
  （`@diy-agent/workbench` 的 `cdp.ts`）。写死时第二个实例 `bind() failed`，CDP 静默不可用。
- 对外发现面：只开 `/ping`（无鉴权、缺省绑回环），拿到端口后 `updateSelfRecord({ pingPort })` 回填注册表。

## 6. 现状与待办（标注）

| 项 | 状态 |
|---|---|
| `dev` 的 React UI（`pkgs/dev-ui`） | ✅ 已迁移并作为默认界面；老手写 DOM 入口已删 |
| `dev` 的 `/ping` + 注册表回填 + CDP 端口 0 + 数据根级单实例 | ✅ 已落地 |
| `dev` 的 h2c RPC 端口（`port` 字段） | ⏳ 未做；`page:invoke` 仍只走 Electron IPC，`diy remote` 还不能把 dev 当远端操作 |
| `diy-app`（44k 行 SolidJS） | 🔒 **冻结**，不重写；等自然大改时再谈 |
| `diy2`（`apps/chat`） | ✅ ##526 已换 React 19 + shadcn 组件（`chat-page/src/renderer-react.tsx`，CDP 判据 1–6 全过） |
| diy2 的 renderer 版本冗余 | ✅ 已删裸 DOM / diyui 两版；`@diy-agent/ui` 依赖一并去掉，三个宿主（chat / minimal / web）都指向 `renderer-react` |
| diy2 的 tailwind 构建 | ✅ `apps/chat/sha.sh build-renderer` 里跑 `@tailwindcss/cli`（入口 `chat-page/src/react.css`） |
| `@material/web` / Web Awesome 在 `dev` 的残留依赖 | ⏳ 组件替换后清理 |
| `@diy-agent/ui`（diy-ui 运行时：Signal / GenApp / DOM DSL） | ⏳ **已无使用方**（##526 删掉 diyui 版后）。要么明确留作插件/终端渲染的公开包并写清用途，要么冻结下架 —— 别让它半活 |
| dockview 分屏 POC | ⏳ 未做 |

## 7. 新 app 的落地清单

1. `apps/<app>/` 只放 `main.ts`（装配 + 单实例 + CDP + `/ping`）、`preload.ts`、`index.html`、`renderer.ts`（一行引 UI 包）。
2. 建 `pkgs/<app>-ui/`：`store` / `slots` / `client` / `chrome` / 页面组件；`client.ts` 是唯一的协议面。
3. 用 `@diy-agent/workbench` 的外壳能力：实例记录、单实例锁、`cdp.ts`、`instance-home.ts` —— 别自己再写一份。
4. 视觉只吃 `@diy-agent/ui-design` 的令牌；需要 tailwind 时 `@source` 自己声明。
5. 写页面时先想三件事：**数据从哪个 store 来、扩展点要不要 Slot、这个动作属于哪个 client 方法**。

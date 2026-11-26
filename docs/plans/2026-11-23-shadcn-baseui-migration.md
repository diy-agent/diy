# shadcn + Base UI 迁移：组件落点与替换映射（2026-11-23）

> 主线目标：**减少自建组件数量**。判据不是「用了什么库」，而是「仓库里手写控件点少多少个、同一份组件是否只有一个真源」。

## 0. 本轮已完成（2026-11-23，worktree `shadcn-baseui`）

用户裁定：新建 `pkgs.ts/ui/shadcn`（`@diy-agent/ui-shadcn`），范围 = 22 个组件 + 语义变量 + `cn` + 收编 assistant-ui 侧 6 个重复件。

| 做了什么 | 结果 |
|---|---|
| 新建 `@diy-agent/ui-shadcn` | 22 个 base-nova 组件（1371 行）、`lib/cn.ts`、`styles.css`（145 行语义变量）、`components.json`、`AGENTS.md` |
| 语义变量搬家 | `entity-chat/styles.css` 从 142 行降到 17 行，只剩 `tw-shimmer` 与链接兜底 |
| 收编重复 | `assistant-ui/components/ui/` 6 个文件（369 行）删除，4 个调用点改指向新包（导出名完全一致，零 API 适配） |
| `cn` 搬家 | `assistant-ui/cn.ts` → `ui-shadcn/src/lib/cn.ts`；7 处 import 改指新包 |
| `Modal` 换实现 | 自建 42 行（ESC 挂 document + 遮罩点击 + stopPropagation）→ 20 行 `Dialog` 适配层；5 个业务弹窗零改动 |
| 验证 | `tsc` 三个包全绿（ui-shadcn / entity-chat / diy2）、`oxlint` 0 error（5 warning 在 main 上同样存在）、`check-pkg-visibility` 通过 |


## 1. 事实基线（2026-11-23 核验）

| 项 | 值 | 怎么核的 |
|---|---|---|
| Base UI 现役包 | **`@base-ui/react` 1.9.0**（2026-10-09，MIT，未压 10.4MB） | `npm view` |
| 旧包名 | `@base-ui-components/react` 停在 `1.0.0-rc.0`（已弃） | 同上 |
| shadcn CLI | 4.23.0，支持 `-b base｜radix｜aria`，default preset `base-nova` | `npx shadcn init --help` |
| registry 风格 | `base-nova` / `base-maia` / `base-lyra` / `base-mira` | 逐个探 URL |
| 组件覆盖面 | 31 个常用组件全部存在；registry 自带 npm 依赖只有 `cmdk`、`react-resizable-panels`、`sonner` | 脚本批量探 |
| 我们已装的底座 | `@base-ui/react ^1.9.0`、`clsx`、`cva`、`tailwind-merge`、`tw-animate-css`、`lucide-react`、Tailwind v4 | `entity-chat/package.json` |
| 已有 shadcn 产物 | `entity-chat/src/assistant-ui/components/ui/` 6 个（369 行，Base UI 原语） | `wc -l` |
| 已有语义变量 | `entity-chat/src/styles.css` 23 个 `--color-*`，**新组件所需一个不缺**（脚本比对） | 见 §5 |
| 名字冲突 | `@diy-agent/ui-kit` **已被 SolidJS 占用**（`apps/diy-app` 在用，最近仍有提交） | `rg @diy-agent/ui-kit` |

**落点结论：新建独立包，不复用 `ui-kit` 之名，也不放各业务包内。** 依据：

1. 重复已经发生过一次 —— `assistant-ui/components/ui/` 与刚落盘的 22 个重叠 6 个（dialog/avatar/tooltip/button/textarea/collapsible）。
2. 加包成本≈0 —— ui 包都是 `main: src/index.ts` 源码直出（`entity-chat`/`chat-core` 无 build 脚本），由 app 的 vite 编译。
3. 依赖方向 —— `diy2` 已依赖 `@diy-agent/entity-chat`（为 `ChatPanel`）；工作台为一个 `Button` 依赖「实体对话」包是错误的。

分层：`design`（M3 令牌）→ **`ui-shadcn`**（组件 + 语义变量 + `cn`）→ `entity-chat` / `workbench`（业务）。

## 2. 手写控件点分布（现状量化）

| 文件 | 行数 | 手写控件/交互点 | 性质 |
|---|---|---|---|
| `Dialogs.tsx` | 385 | **24** | 5 个业务弹窗 + 自建 `Modal` 外壳 |
| `AskCard.tsx` | 629 | 21 | 多问题卡片（业务核心） |
| `TaskPanel.tsx` | 363 | 12 | 表单（业务） |
| `RoomName.tsx` | 264 | 10 | 重命名输入 |
| `RoomRow.tsx` | 264 | 9 | 列表行 |
| `ContextPanel.tsx` | 183 | 9 | 折叠面板 |
| `surfaces/shadcn/Surface.tsx` | 383 | 7 | 对话流 |
| `SpeakingBar` / `Sidebar` | 51 / 223 | 4 / 4 | 状态条 / 侧栏 |
| `ModelPicker.tsx` | 101 | 3 | 三段原生 `<select>` |
| `AreaHost.tsx`（workbench） | 809 | 14 | tab / `⋯` 菜单 / resizer |
| `window.tsx`（workbench） | 207 | 2 | 标题栏按钮 |
| `glyphs.tsx`（workbench） | 86 | — | 手绘 SVG，`lucide-react` 已有 |

## 3. 替换映射（按「收益 / 风险」排序）

### 第一梯队：整件替换，净减行数明确

| 自建 | 目标（base-nova） | 预期 | 顺带修掉的缺陷 |
|---|---|---|---|
| `Modal`（Dialogs.tsx:11-42） | `dialog` | −30 行 | 无 focus trap、无 `role=dialog`/`aria-modal`、无初始焦点与焦点还原、无滚动锁、ESC 挂 document 会一次关掉嵌套层 |
| `ModelPicker` 三个原生 select | `select` | 行数持平，**能力净增** | 无搜索、键盘只有原生行为、provider/account/model 三段无联动提示 |
| `ErrorBar` 26 行 | `alert` | −10 行 | — |
| ~~`BotAvatar` 52 行~~ | ~~`avatar`~~ **不换** | 0 | 它是「带色圆 + 分类图标」，没有图片；shadcn Avatar 只解决 `img` 加载失败与裁剪，强换更绕 |
| `glyphs.tsx` 86 行 | `lucide-react` | −86 行 | 手绘图标与图标库混用 |
| `ContextPanel` 折叠 | `collapsible` | −20 行 | 无 `aria-expanded` 的原生实现 |
| `AreaHost` 的 `⋯` 菜单 | `dropdown-menu` | −40 行 | 只有 ESC，无方向键 / 首字母 / 焦点归还 |
| `AreaHost` 的 tab 条 | `tabs` | −30 行 | 无方向键切换 |
| `AreaHost` 的 resizer | `resizable`（49 行，用 `react-resizable-panels`） | 待评估 | 键盘不可达（当前只有 pointer 事件） |

### 第二梯队：内部控件替换（业务文件瘦身，不动业务逻辑）

| 自建 | 目标 |
|---|---|
| `Dialogs.tsx` 里 5 个弹窗的 header/footer/关闭按钮 | `DialogHeader` / `DialogFooter` / `DialogClose` / `button` |
| `TaskPanel` 的输入框与标签 | `field` + `input` / `textarea` / `label` |
| `AskCard` 的选择控件 | `radio-group` / `checkbox` / `textarea` |
| `Sidebar` / `RoomRow` 的滚动与折叠 | `scroll-area` / `collapsible` |

### 不替换（明确写下理由）

- `Markdown` 89 行 —— shadcn 不含 markdown，`react-markdown` 已经在用，自建部分是样式壳。
- `AskCard` 的 629 行主体 —— 业务语义（多问题、已答态、跳转高亮），只换内部控件。
- `TaskPanel` 的字段编排与保存逻辑 —— 业务。
- `workbench` 的模型 / 手势层（`model.ts`、`useBarGesture`、折叠条、最大化）—— shadcn 没有对应概念，`AreaHost` 骨架保留。

## 4. 执行顺序

1. `ErrorBar → alert`、`BotAvatar → avatar`、`glyphs → lucide`（零风险，先验证管线）
2. `Modal → dialog`（收益最大，同时修 a11y 欠账）
3. `ModelPicker → select`（能力净增）
4. `AreaHost` 的 `⋯` 菜单与 tab 条（工作台首次接入）
5. 第二梯队（业务文件内部）
6. `resizable` 评估（要权衡丢掉自定义拖拽手势的风险 —— 现有 `Resizer` 有「双击回默认」等行为）

## 5. 验证手段

- **语义变量齐备**：脚本比对组件用到的 `bg-*/text-*/border-*` 与 `styles.css` 的 `--color-*` —— 已跑，缺 0 个（Tailwind 缺类不报错，这类问题只靠眼睛看不出来）。
- **类型**：`tsc --noEmit`（worktree 需先 `npm install`，858M）。
- **视觉/交互**：lab 页逐个组件过键盘（Tab/方向键/ESC/焦点归还）。
- **净减少**：每次替换后 `wc -l` 记账，最终给「自建行数 −N / 手写控件点 −M」的实数。

## 6. 待定（本轮已定）

1. ~~包名~~ → `@diy-agent/ui-shadcn`（`ui-kit` 已被 SolidJS 占用）
2. ~~语义变量归属~~ → 随组件搬进新包
3. ~~assistant-ui 侧 6 个是否收编~~ → 已收编（导出名一致，直接删旧文件）
4. 仍待定：22 个组件的视觉在 diy2 里是否与现有 `--wb-*` 变量打架（需 lab 实机过一遍）

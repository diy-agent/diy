# @diy-agent/ui-kit — 纯展示组件库

## 进包判据（三条，全满足才进，见 ##448）

1. 不 import 任何 `store/*`
2. 不 import `lib/rpc` 或任何 RPC 调用
3. props 进、DOM 出；自身无跨组件共享状态（含 `lib/theme` / `lib/ui-state` 这类全局单例）

`package.json` 的 `dependencies` **只允许 `solid-js`**：`@diy-agent/*`、三方渲染库（`solid-markdown` / `shiki` / `js-yaml` …）都不许进来。

## 现有内容

| 文件 | 是什么 |
|---|---|
| `icons.tsx` | 内联 SVG 图标集（`currentColor`，不引第三方图标库） |
| `RowGutter.tsx` | 行首竖列折叠条（`data-row-band` / `data-row-handle` 钩子，样式在 diy-app 的 `index.css`） |
| `DrawerMaximize.tsx` | 抽屉「默认高 ⇄ 满屏」hook + 按钮 |
| `ConfirmDialog.tsx` / `DeleteEntryButton.tsx` / `DynamicBar.tsx` / `ViewBoundary.tsx` | 通用小组件 |
| `ChatGlyph.tsx` / `ChatSkinPreview.tsx` | 会话图标的明暗两档 / 皮肤小样（零逻辑，样式钩子来自 `index.css`） |
| `z-layers.ts` / `bytes.ts` | 全局层级常量 / 字节数格式化（纯函数） |

## 检查

`./sha.sh check`（tsc `--noEmit` + oxlint）。根 `./sha.sh check` 通过 `tsconfig.all.json` 一并检查本包。

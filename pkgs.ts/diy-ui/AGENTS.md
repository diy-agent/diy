# @diy/ui（目录 `diy-ui`）— 声明式 UI 层

> 全仓契约见**仓库根 `AGENTS.md`**。npm 发布名 `@diy/ui`（发布流程见根 `tool.publish`）；历史名 `diyui`。
>
> ⚠️ 浏览器侧**绝不 import 根入口** —— 根入口 re-export 了 pi-tui（Node-only），打包器会把它拖进 bundle。
> 安全入口 = `@diy/ui/browser`（细粒度另有 `./signal` `./host` `./dom` `./dom-dsl` `./dom-gen`）。

## 正文在知识库，本节只留目录

原先写在下面的 12 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/`，逐条带
`evidence.at: cdb037fd:pkgs.ts/diy-ui/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 2.7 KB → 1.6 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `ui.find` | 包内定位：核心树形运行时 / 浏览器入口 / HostAdapter / providers / demo 站 / 发布形态 | 6 |
| `ui.rule` | 硬约束：DOM 类型自取 / 浏览器入口不许走根入口 / 控件层交 Web Awesome / ESM 扩展名 / 发布 / 不放 lock | 6 |

**取法**：

- `diy facts brief ui.rule` — 该主题全部条目 + 每条首句
- `diy facts get 'ui.rule#browser-entry'` — 单条完整值
- `diy facts brief 'ui.*'` — 全包一次拿

⚠️ **改 `src/providers/**` 或动 `exports` 前 brief 一次 `ui.rule`**。两条最容易破：`browser-entry`
（新增子路径入口时把 pi-tui 带进浏览器链路 —— 症状是打包器报 Node 内置缺失，报错点离根因很远）
和 `dom-lib`（图省事把 DOM 加进 `tsconfig.lib`，核心层的 `document` 误用从此不报错）。

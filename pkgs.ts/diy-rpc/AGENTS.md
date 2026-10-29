# @diy/rpc — RPC 协议内核

> 全仓契约见**仓库根 `AGENTS.md`**。npm 发布名 `@diy/rpc`（发布流程见根 `tool.publish`）。
>
> 需求真源是测试：`test/*.test.ts`。

## 正文在知识库，本节只留目录

原先写在下面的 8 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/`，逐条带
`evidence.at: e05fa9c3:pkgs.ts/diy-rpc/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 2.0 KB → 1.3 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `rpc.find` | 包内定位：根入口与子路径 exports / 核 `src/core` / 传输三件套 / CLI 桥 / 发布形态 | 5 |
| `rpc.rule` | 硬约束：ESM `.js` 扩展名 / **浏览器安全边界（核安全、传输不承诺）** / 发布流程 | 3 |

**取法**：

- `diy facts brief rpc.rule` — 该主题全部条目 + 每条首句
- `diy facts get 'rpc.rule#browser'` — 单条完整值
- `diy facts brief 'rpc.*'` — 全包一次拿

⚠️ **改 `src/core/**` 前至少 brief 一次 `rpc.rule`**。最容易破的是两条：
`browser`（Node API 只准进 `transport/**` 与 `cli/**` —— `check-browser` **不覆盖传输层**，写错了它不报）
和 `esm-ext`（相对 import 漏 `.js` 时 vite/vitest 绿、`tsc -p tsconfig.build.json` 才红）。

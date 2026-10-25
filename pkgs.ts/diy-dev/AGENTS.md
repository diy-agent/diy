# diy-dev — ref（仓库引用 / vendor 镜像）CLI

> 全仓契约见**仓库根 `AGENTS.md`**。本包是独立的 `dev` 命令，**不是** diy 应用的一部分。
>
> ⚠️ **cwd 即作用域**：`diy.yaml` 在哪个目录就在哪操作；`bin/dev` 刻意不 cd 到包根。

## 正文在知识库，本节只留目录

原先写在下面的 10 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/`，逐条带
`evidence.at: 115d5522:pkgs.ts/diy-dev/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 1.9 KB → 1.5 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `diydev.find` | 包内定位：进程内 RPC 入口 / ref 子模块 / runtime / 两条跑法 | 4 |
| `diydev.rule` | 硬约束：cwd 即作用域 / `ref.lock.yaml` v1 唯一写入方 / 镜像路径 / 版本钉法 | 4 |
| `diydev.tool` | 命令入口与自检方式 | 2 |

（前缀用 `diydev.*` 而非 `dev.*`：`dev` 已是「开发流程打法」的 subject，`tool` 是通用工具主题，
混用会把两类事实搅进同一张 claim 表。）

**取法**：

- `diy facts brief diydev.rule` — 该主题全部条目 + 每条首句
- `diy facts get 'diydev.rule#lock-format'` — 单条完整值
- `diy facts brief 'diydev.*'` — 全包一次拿

⚠️ **改 `ref.lock.yaml` 格式前 brief 一次 `diydev.rule`**：本包是它**全仓唯一写入方**
（diy-app 侧 v5 写引擎已在 ##387 删除），改格式不会再触发另一侧的对拍 —— 也就意味着改错没人拦。

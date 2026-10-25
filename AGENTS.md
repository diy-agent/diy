# diy — 主 monorepo

> 主线 `pkgs.ts/`（TypeScript + Electron）。`pkgs/` Python 已归档 —— 代码在，**能力已放弃**，一切以 TS 为准。

## 正文在知识库，本节只留目录

原先写在下面的 43 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/*.yaml`，逐条带 `evidence.at` 指回本文件旧行号）。本文件从 9.4 KB 降到 1 KB —— 那 8 KB 原本每轮都进 system，而其中大半一辈子用不到一次。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `find` | 去哪找（各包的职责与路径） | 12 |
| `entry` | 实例三态 / 端口身份 / 数据根风险 | 5 |
| `tool` | 命令（check / test / cli / publish / sync 与各自的坑） | 13 |
| `rule` | 硬约束（类型检查入口、探针、并发、任务写入契约） | 8 |
| `model` | 本地 agent 测试用什么模型 | 5 |

**取法**（`diy facts` 任意目录可跑，不必在仓库里）：

- `diy facts brief find` — 该主题**全部条目 + 每条首句（≤80 字）**，据此决定展开哪条
- `diy facts get find#app` — 单条完整值（`get` 要精确 claim，没先 brief 就查不到）
- `diy facts find 关键词` — 不知道属于哪个主题时用（多词逗号分隔 = 与）

⚠️ **开工前至少 brief 一次 `find`（这功能在哪）与 `rule`（硬约束，破了要返工）** —— 这两节原本每轮自动在眼前，现在改成你主动取。漏取的代价是不知道有这条约束，不是查不到（查一次 1~3 KB，全量常驻 8 KB/轮）。

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`

# diy — 主 monorepo

> 主线 `pkgs.ts/`（TypeScript + Electron）。`pkgs/` Python 已归档 —— 代码在，**能力已放弃**，一切以 TS 为准。

## 正文在知识库，本节只留目录

原先写在下面的正文已整体迁进**项目知识库**（真源 `.diy/knowledge/**/*.md`，多级 markdown、文件名即索引；旧 yaml 事实库 `knowledge/facts/` 已于 2026-11-19 退役）。本文件从 9.4 KB 降到 1 KB —— 那 8 KB 原本每轮都进 system，而其中大半一辈子用不到一次。

| 主题 | 是什么 | 文件 · 小节 |
|---|---|---|
| `find` | 去哪找（各包的职责与路径） | `find/find.md` · 19 |
| `entry` | 实例三态 / 端口身份 / 数据根风险 | `entry/entry.md` · 13 |
| `tool` | 命令（check / test / cli / publish / sync / dev 启动器 `run`·`app` 与各自的坑） | `tool/tool.md` · 31 |
| `sha` | sha.sh 机制：入口链路 / `#:` 注释即帮助 / `sha.def`·`sha.parse` 声明参数 / 父子命令 / `vendor/sha` 同步 | `sha/sha.md` · 5 |
| `rule` | 硬约束（类型检查入口、探针、并发、任务写入契约、worktree、提交） | `rule/*.md` · 38（6 文件） |
| `model` | 本地 agent 测试用什么模型 | `model/*.md` · 7（2 文件） |

**取法**（在仓内任意目录跑 —— `diy2 facts` 按 **cwd 找库**，仓外只看到设备库）：

- `diy2 facts brief <目录>` — 该目录下**全部条目 + 每条首句（≤80 字）**，据此决定展开哪条（如 `brief rule` 列 rule/ 全部 6 文件）
- `diy2 facts get find/find#app` — 单节正文（`<路径>#<小节>`；路径可省 `.md`）
- `diy2 facts find 关键词` — 不知道属于哪个主题时用（多词逗号分隔 = 与）

⚠️ **开工前至少 brief 一次 `find/find`（这功能在哪）与 `rule`（硬约束，破了要返工）** —— 这两节原本每轮自动在眼前，现在改成你主动取。漏取的代价是不知道有这条约束，不是查不到（单主题 1~3 KB，索引本身每轮常驻）。

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`

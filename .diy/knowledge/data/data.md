---
desc: 项目里的数据文件（依赖源 / 工作区）
updated: 2026-10-25
---

## aux

`personas.yaml` agent 人物 · `log/` 应用日志 · `ref/` 引用仓库快照 · `models/` 模型快照

## big-dirs

仓内大目录（`du -d 1 -h` 实测 2026-10-22，主仓 3.0G）：`.venv` 1.5G · `_diy.worktrees` 873M（历史遗留）+ `diy.worktrees`（现行 worktree 位置，属仓内、已在 `.gitignore`）· `node_modules` 386M · `build` 148M（各 worktree 可达 1G）。全部在 `.gitignore` 内 ⇒ `rg` / `fd` 自动跳过；扫仓外或新仓先看 `du` 再 `-g` 排除

## dead

已废弃：`app.sock`（PySide6 遗留，仅剩 `.bak`）、`star/`（不存在）、`task/`（旧任务池，现行用 `projects/`）

## diy-yaml

`diy.yaml` diy 的 vendor 依赖源列表

## local

**会话数据在全局 `local/`**（不在任务目录下）：现行分层 `local/projects/<pid>/tasks/<tid>/<key>/*.jsonl`（##379），旧平铺 `local/<sessionKey>.*.jsonl` 读侧兜底（`sessionKey` 形如 `projects_4_tasks_266-07a945e1d52d`）。`ops` = 原始事件流（**当前唯一 replay 真源**，方向降为审计见 `data.log`）· `llm` = 真发请求/响应全文 · `usage` = 每步用量 · `compact` = 压缩事件 · `steps` = 逐步全文 · `changelog` = 上下文变更

## log

**观测数据三档定性**（2026-10-24 用户拍板；旧「ops 等同数据、一律不许清」**作废**）：① `local/` 下 `ops`/`llm`/`steps`/`usage`/`compact`/`changelog` = **会话数据**，长期要留的真数据 = **user message + 每步结论 + ref**；`ops` 降为**审计/统计**（方向可开可关可清，结论数据落 L3 `turns.jsonl`）② `log/` 下 `network`/`error`/`job`/`compact` = **纯粹可清**（流量与审计，删了不影响运行）③ **`local/` 代码落地前别批量清** —— ops 目前仍是唯一 replay 真源，L3 未上线。设计见 ##410(观测数据体量治理) / ##424(L3 结论数据层) / ##420(ops 冷路径 seek)

## port

`app.port` 运行中实例的 RPC 端口（HTTP/2，默认 18888）

## state

`state.yaml` 核心状态，**运行中的应用独占写入，禁止手改**（改任务/项目走 CLI）

## tasks

`projects/<pid>/tasks/<tid>/AGENTS.md` = **任务本体唯一权威**（frontmatter state/title/updated + body）；任务目录内只有它和 `gen/`（长期产物）、`.diy/`（运行时暂存）

## workspace

`*.code-workspace` VS Code 工作区文件

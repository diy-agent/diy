---
desc: diy 自己的 ref 镜像实现（diy.yaml 注册 → clone/pull → lock）
updated: 2026-11-02
---

## git-hardening

git 调用防御：统一 `GIT_TERMINAL_PROMPT=0`（不卡在交互）；**clone / pull 不设硬超时**（曾上过 180 s 被故意删掉——会误杀大仓库，卡住靠 Ctrl+C）；`ls-remote` 15 s、单 ref fetch 60 s 超时；长命令走 `runStreaming` + ProgressRenderer（TTY 原地重绘 / 非 TTY 里程碑行），不再「跑完才 dump」黑屏。

## layers

分层（改哪一处先看头注）：`api.ts` schema → `store.ts` URL 解析 + diy.yaml/lock 读写 → `git.ts` 子进程封装 → `impl.ts` 命令编排（add/sync/list/remove）→ `render.ts` 进度渲染 → `progress.ts`。

## simplified

**现行是「简化版」**：不做 py/node 依赖扫描，只处理人工写进 `diy.yaml` 的 source，`sync` 批量 clone 到 `$DIY_HOME/ref/<key>`（`_sync.py` 那种 lock 文件驱动整棵依赖树的逻辑没搬）。`docs/plans/2026-07-10-ref-rewrite.md` 里的 v2 设计（lock 文件判项目边界 / monorepo scope / `--all` `--scope`）**未实现**，别按文档推行为。

## tree-ambiguity

`/tree/` 有天然歧义（分支 `feat/foo` 的根 vs 分支 `feat` 下的 `foo` 目录）：**一律按 ref 名整体解释** `/tree/` 后段；解析失败时提示改用 `@<分支>` 精确形式。`/tree` 结尾视作仓库根。

## url-shape

`diy ref` 认的 source 形状：`<url>@<branch|tag>`（精确形式，SSH 也用它）· `<url>/tree/<ref>`（浏览页，后段整体即 ref 名）· `<url>/commit/<40 位 sha>` · `<url>/releases/tag/<t>`。**不认的页面形态**（issues/pulls 等）直接报错并提示改用仓库根或 `@版本`。

## version-semantics

检出策略（决定后续 sync 会不会 pull）：**无版本 / main** → 保持默认分支 HEAD（track `origin/默认分支`，**可 pull**）；**SHA / tag** → detached 检出，**后续不 pull**（tag 含非 semver 如 `nightly`，以 clone 到的本地 `refs/tags/` 消歧）；**显式分支名**（`develop`、`feat.x`，斜杠分支整体作 ref 名）→ `checkout -B <v> origin/<v>` 本地 track，**可 pull**。

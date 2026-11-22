---
desc: 开工前的环境准备（worktree / 依赖 / 任务文件写入规矩）
updated: 2026-10-21
---

## sync

新 worktree 先 ./sha.sh sync（npm i --workspaces --include-workspace-root + 子模块 + 各包 sync）；只跑 --workspaces 会漏装根依赖，干净 worktree 上必现 build 解析失败

（见 docs/toolchain.md:32）

## hooks-path

钩子真源在仓内 `.githooks/`（进版本控制、各 worktree 跟自己的分支走）。本机**一次性**配置：

    git config core.hooksPath .githooks      # 仓库级；worktree 共享同一份 config，设一次全生效

相对路径的基准是**工作树根**（githooks(5)：钩子运行前 git 会 chdir 到非裸仓的工作树根）—— 子目录里跑 git 也一样命中。

| 钩子 | 拦什么 | 豁免 |
|---|---|---|
| `pre-merge-commit` | 在 main 上做本地 merge（本地合并 = 不进 PR、别人看不见，等别人并了 PR 就成 main 分叉） | `DIY_ALLOW_MAIN_MERGE=1` |
| `pre-push` | 直推 main（让 main 只由 PR 前进） | `DIY_ALLOW_MAIN_PUSH=1` |
| `post-commit` | Qoder tracker（从 `.git/hooks/post-commit` 搬来；无 `~/.local/bin/qodercli` 时静默跳过） | — |

另设 `git config pull.ff only`：pull 出现分叉时**直接报错**，而不是静默造一个 merge commit（那个 merge commit 正是 2026-11-22 分叉的形态）。收口用 `git pull --rebase`。

判据：`git config --get core.hooksPath` 得 `.githooks`，且 `./sha.sh check` 不报「hooksPath 指向不存在的目录」。

踩坑：改动前它被设成绝对路径 `/Users/ccc/git/diy/.git/hooks` —— 该目录不存在（`~/git/diy` 根本不是 git 仓），而 git 对坏 hooksPath **静默不回退**：全部 worktree 的所有钩子实际都不触发，连 Qoder 的 `post-commit` 都哑着。改配置前必须先把 `.git/hooks/` 里的手写钩子搬进 `.githooks/`，否则改完就丢。

## task-write

任务文件头是权威：读侧 task show 给的就是 frontmatter；--body 只收内联正文（值形如单行路径即拒），整篇文件走 --body-file / 追加走 --append-body-file

（见 docs/task-write-contract.md:1）

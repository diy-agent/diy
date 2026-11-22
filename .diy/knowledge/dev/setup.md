---
desc: 开工前的环境准备（worktree / 依赖 / 任务文件写入规矩）
updated: 2026-10-21
---

## sync

新 worktree 先 ./sha.sh sync（npm i --workspaces --include-workspace-root + 子模块 + 各包 sync）；只跑 --workspaces 会漏装根依赖，干净 worktree 上必现 build 解析失败

（见 docs/toolchain.md:32）

## hooks-path

钩子真源在仓内 `.githooks/`（进版本控制）。本机**一次性**配置 —— **用绝对路径指主仓那份**：

    git config core.hooksPath /Users/ccc/git/diy/diy/.githooks

为什么不用相对路径 `.githooks`：相对路径的基准是**各工作树自己的根**（githooks(5)：钩子运行前 git 会 chdir 到非裸仓的工作树根），而 `.githooks/` 只在已 rebase 到 origin/main 的工作树里才存在 —— 未 rebase 的 worktree 上它指向不存在的目录，git **静默跳过**（2026-11-22 实测：15 个 worktree 里有 13 个处于这种无保护状态）。绝对路径指主仓那份，一次配置全 worktree 生效，不要求各自 rebase；代价是钩子内容跟主仓工作树的当前 checkout 走 —— 主仓常驻 main 时可接受（改钩子也只能从 PR 进 main）。

| 钩子 | 拦什么 | 豁免 |
|---|---|---|
| `pre-merge-commit` | 在 main 上做本地 merge（本地合并 = 不进 PR、别人看不见，等别人并了 PR 就成 main 分叉） | `DIY_ALLOW_MAIN_MERGE=1` |
| `pre-push` | 直推 main（让 main 只由 PR 前进） | `DIY_ALLOW_MAIN_PUSH=1` |
| `post-commit` | Qoder tracker（从 `.git/hooks/post-commit` 搬来；无 `~/.local/bin/qodercli` 时静默跳过） | — |

另设 `git config pull.ff only`：pull 出现分叉时**直接报错**，而不是静默造一个 merge commit（那个 merge commit 正是 2026-11-22 分叉的形态）。收口用 `git pull --rebase`。

判据：`git config --get core.hooksPath` 得那条绝对路径；任一 worktree 里 `git hook run pre-commit` 返回 0（不是 `cannot find hook`）；`./sha.sh check` 不报「hooksPath 指向不存在的目录」；`git push --dry-run <临时 bare 仓> HEAD:main` 被拒。

验 `pre-push` 别用 `git hook run`：**git 2.49 的 `git hook run` 不转发 stdin**，脚本读不到 refs 就静默放行，看起来像「钩子失效」。要用 `git push --dry-run`（钩子照跑但不传数据），远端可以就地 `git init --bare /tmp/probe.git`。

踩坑：改动前它被设成绝对路径 `/Users/ccc/git/diy/.git/hooks` —— 该目录不存在（`~/git/diy` 根本不是 git 仓），而 git 对坏 hooksPath **静默不回退**：全部 worktree 的所有钩子实际都不触发，连 Qoder 的 `post-commit` 都哑着。改配置前必须先把 `.git/hooks/` 里的手写钩子搬进 `.githooks/`，否则改完就丢。

## task-write

任务文件头是权威：读侧 task show 给的就是 frontmatter；--body 只收内联正文（值形如单行路径即拒），整篇文件走 --body-file / 追加走 --append-body-file

（见 docs/task-write-contract.md:1）

---
desc: 开工前的环境准备（worktree / 依赖 / 任务文件写入规矩）
updated: 2026-10-21
---

## sync

新 worktree 先 ./sha.sh sync（npm i --workspaces --include-workspace-root + 子模块 + 各包 sync）；只跑 --workspaces 会漏装根依赖，干净 worktree 上必现 build 解析失败

（见 docs/toolchain.md:32）

## task-write

任务文件头是权威：读侧 task show 给的就是 frontmatter；--body 只收内联正文（值形如单行路径即拒），整篇文件走 --body-file / 追加走 --append-body-file

（见 docs/task-write-contract.md:1）

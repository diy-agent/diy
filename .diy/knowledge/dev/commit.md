---
desc: 提交的硬性要求
updated: 2026-11-22
---

## signing

所有 git 操作必须 GPG 签名，失败即停并求助，禁 --no-gpg-sign

## finish

分支收尾**只有一条路**：`git push -u origin $(git branch --show-current)` + `gh pr create --fill`。

禁在 main 上 `git merge` 本地分支：本地 merge 不进 PR、远端看不见，期间别人并了 PR 就成 main 分叉（2026-11-22 复盘：bot 把两个主题分支 merge 进本地 main 不 push，一小时后主仓 pull 造出分叉）。

硬拦点（`.githooks/`，启用见 `dev/setup.md#hooks-path`）：

- `pre-merge-commit` —— main 上的本地 merge，除非 `DIY_ALLOW_MAIN_MERGE=1`
- `pre-push` —— 直推 main，除非 `DIY_ALLOW_MAIN_PUSH=1`
- `pull.ff only` —— pull 分叉时直接报错，不静默造 merge commit（收口用 `git pull --rebase`）

判据：收工时 `git rev-parse main` == `git rev-parse origin/main`，且 `./sha.sh check` 不报 main 漂移（scripts/check-git-state.sh）。

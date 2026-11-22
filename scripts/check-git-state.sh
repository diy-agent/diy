#!/usr/bin/env bash
# scripts/check-git-state.sh —— 本机 git 状态的两条「可解释性」检查（##534）
#
# 起因：2026-11-22 main 分叉复盘。让事故真正成立的不是谁违规，而是一条**静默失效**：
#   core.hooksPath = /Users/ccc/git/diy/.git/hooks（该目录不存在，~/git/diy 根本不是 git 仓），
#   而 git 对坏 hooksPath **静默不回退** —— 于是全部 worktree 的所有钩子（连 Qoder 的
#   post-commit）实际都不触发。想加的 merge 拦截在那种状态下等于没装，且没人会发现。
# 所以把两件事变成 check 的一部分：
#   ① hooksPath 不指向真实目录 / 目录里没有可执行的 pre-* ⇒ 告警（护栏等于没装）
#   ② local main vs origin/main 的 ahead/behind 非零 ⇒ 告警（本地 main 有别人看不见的提交）
# 两者都只告警不失败：check 是「能不能提交」的门槛，不该被本机配置或别人的进度卡住。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 0

warn() { printf '⚠ %s\n' "$1" >&2; }

# ① hooksPath 有效性（相对路径的基准是工作树根 —— 见 githooks(5) DESCRIPTION：
#    钩子运行前 git 会 chdir 到非裸仓的工作树根）
hooks=$(git config --get core.hooksPath 2>/dev/null || true)
if [ -n "$hooks" ]; then
  case "$hooks" in
    /*) dir=$hooks ;;
    *) dir="$(git rev-parse --show-toplevel 2>/dev/null)/$hooks" ;;
  esac
  if [ ! -d "$dir" ]; then
    # 相对路径在未 rebase 的 worktree 上就是这样指向虚空的 —— 引导用主仓那份的绝对路径
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
    suggest="${common%/.git}/.githooks"
    warn "core.hooksPath 指向不存在的目录：$hooks —— 当前全部 git 钩子都不触发（静默失效）"
    warn "  处置：git config core.hooksPath ${suggest}（绝对路径，全部 worktree 一次生效）"
    warn "  说明见 .diy/knowledge/dev/setup.md#hooks-path"
  else
    any=0
    for h in pre-commit pre-merge-commit pre-push pre-rebase; do
      if [ -x "$dir/$h" ]; then any=1; break; fi
    done
    [ "$any" = 1 ] || warn "core.hooksPath（$hooks）里没有可执行的 pre-* 钩子 —— 护栏不生效"
  fi
fi

# ② local main 与 origin/main 的漂移
if git rev-parse --verify --quiet refs/heads/main >/dev/null 2>&1 &&
  git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
  counts=$(git rev-list --left-right --count refs/heads/main...refs/remotes/origin/main 2>/dev/null || true)
  if [ -n "$counts" ]; then
    read -r ahead behind <<<"$counts"
    if [ "$ahead" != "0" ] || [ "$behind" != "0" ]; then
      warn "local main vs origin/main：ahead ${ahead} / behind ${behind}"
      if [ "$ahead" != "0" ]; then
        warn "  ahead = 本地 main 有未推提交（收尾应走「push 分支 + 开 PR」，不该在 main 上攒提交）"
      fi
      if [ "$behind" != "0" ]; then
        warn "  behind = 远端已前进，本地该快进：git fetch && git merge --ff-only origin/main"
      fi
    fi
  fi
fi

exit 0

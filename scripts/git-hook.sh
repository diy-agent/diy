#!/usr/bin/env bash
# 共享 pre-commit hook（core.hooksPath=~/git/diy/.git/hooks）
# 仅对 diy 仓库的 diyui.py 子项目生效
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

cd "$repo_root"
./sha.sh ws check && ./sha.sh ws test|| {
  echo ""
  echo "❌ ./sha.sh check 失败，提交已阻止。"
  echo "   请修复后重试，或 git commit --no-verify 跳过。"
  exit 1
}

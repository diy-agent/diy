#!/bin/bash
# lint-env — 开发环境质量检查
# 回答"好不好" — 配置建议、最佳实践、漏配项
# 用法: bash scripts/lint-env.sh [-v]
#   -v  详细模式
#
# 完全只读，可安全用于 CI / 本地诊断

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERBOSE=false
if [[ "${1:-}" == "-v" ]]; then
  VERBOSE=true
fi

PASS=0
FAIL=0
WARN=0

pass()  { PASS=$((PASS+1)); printf "  ✓ %s\n" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf "  ✗ %s\n" "$1"; }
warn()  { WARN=$((WARN+1)); printf "  ⚠ %s\n" "$1"; }
info()  { printf "    %s\n" "$1"; }

header() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

echo "lint-env"
echo "运行时间: $(date '+%Y-%m-%d %H:%M:%S')"

# ================================================================
# 1. ~/.ssh/config 最佳实践
# ================================================================
header "1. SSH 配置最佳实践"

if [[ -f ~/.ssh/config ]]; then

  if grep -q 'AddKeysToAgent yes' ~/.ssh/config; then
    pass "AddKeysToAgent yes — 首次使用密钥后自动保存到 keychain"
  else
    warn "未配置 AddKeysToAgent yes — 建议添加，避免每次重启后手动 ssh-add"
  fi

  if [[ "$(uname)" == "Darwin" ]]; then
    if grep -q 'UseKeychain yes' ~/.ssh/config; then
      pass "UseKeychain yes — macOS keychain 持久化，重启后自动恢复密钥"
    else
      warn "未配置 UseKeychain yes — 仅 macOS 生效，重启后密钥不会自动恢复"
    fi
  fi

else
  warn "~/.ssh/config 不存在"
fi

# ================================================================
# 2. .gitignore 常见漏配
# ================================================================
header "2. .gitignore 检查"

GITIGNORE_FILE=".gitignore"

check_gitignore() {
  local pattern="$1"
  local desc="$2"
  if [[ -f "$GITIGNORE_FILE" ]]; then
    if grep -q "^${pattern//\//\\/}$" "$GITIGNORE_FILE" 2>/dev/null; then
      pass "$desc ($pattern)"
    else
      warn "$desc 未在 .gitignore 中：$pattern"
    fi
  else
    warn ".gitignore 文件不存在"
  fi
}

check_gitignore ".env" "环境变量文件"
check_gitignore "*.log" "日志文件"

# ================================================================
# 摘要
# ================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║             检查摘要                              ║"
echo "╠══════════════════════════════════════════════════╣"
printf "║  通过: %-2d   警告: %-2d   失败: %-2d             ║\n" "$PASS" "$WARN" "$FAIL"
echo "╚══════════════════════════════════════════════════╝"

echo ""
echo " 退出码始终为 0（lint 不影响流程）。"
exit 0

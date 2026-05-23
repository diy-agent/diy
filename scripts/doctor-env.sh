#!/bin/bash
# doctor-env — 开发环境就绪诊断
# 回答"能不能运行" — 工具链是否存在、签名能否工作、依赖是否安装
# 用法: bash scripts/doctor-env.sh [-v]
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

echo "doctor-env"
echo "运行时间: $(date '+%Y-%m-%d %H:%M:%S')"

# ================================================================
# 1. SSH 密钥 & 签名
# ================================================================
header "1. SSH 密钥 & 签名"

# 1a. ssh-agent 是否运行、是否有密钥（能签名的前提）
if ssh-add -l &>/dev/null 2>&1; then
  KEY_COUNT=$(ssh-add -l 2>/dev/null | wc -l | tr -d ' ')
  pass "ssh-agent 运行中，已加载 $KEY_COUNT 个密钥"
else
  fail "ssh-agent 未运行或无密钥"
  info "启动 ssh-agent: eval \$(ssh-agent -s)"
fi

# 1b. 签名密钥能否用于 commit 签名（关系到 commit 能否成功）
GPG_SIGN=$(git config commit.gpgsign 2>/dev/null || echo "false")
SIGN_KEY=$(git config user.signingkey 2>/dev/null || echo "")

if [[ "$GPG_SIGN" == "true" ]]; then

  if [[ "$SIGN_KEY" == ssh-* ]]; then
    # SSH 签名
    SIGN_FINGERPRINT=$(echo "$SIGN_KEY" | ssh-keygen -lf - 2>/dev/null | awk '{print "SHA256:"$2}' || echo "unknown")
    info "签名方式: SSH"
    info "密钥指纹: $SIGN_FINGERPRINT"

    AGENT_KEYS=$(ssh-add -l 2>/dev/null || echo "")
    SIGN_HASH=$(echo "$SIGN_KEY" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || echo "")

    if [[ -n "$SIGN_HASH" && "$AGENT_KEYS" == *"$SIGN_HASH"* ]]; then
      pass "签名密钥已在 ssh-agent 中加载"
    else
      fail "签名密钥未在 ssh-agent 中加载 — commit 签名会失败"
      info "你配置了 SSH 签名，但 ssh-agent 中找不到对应密钥"
      info "原因: 重启/注销后 ssh-agent 未恢复密钥，且从未触发过 keychain 保存"

      # 查找匹配的私钥文件
      FOUND_KEY=$(find ~/.ssh -maxdepth 1 -name 'id_ed25519' -o -name 'id_rsa' -o -name 'id_ecdsa' 2>/dev/null | head -1 || echo "")
      if [[ -n "$FOUND_KEY" ]]; then
        FOUND_HASH=$(ssh-keygen -lf "$FOUND_KEY".pub 2>/dev/null | awk '{print $2}' || echo "")
        if [[ "$FOUND_HASH" == "$SIGN_HASH" ]]; then
          info "找到匹配私钥: $FOUND_KEY"
          info "修复: ssh-add $FOUND_KEY"
        fi
      fi
      if [[ -z "$FOUND_KEY" || "$FOUND_HASH" != "$SIGN_HASH" ]]; then
        info "未找到匹配的私钥文件，请手动指定路径: ssh-add <私钥路径>"
      fi
      info "绕过签名（临时）: git commit --no-gpg-sign"
    fi

  elif [[ -n "$SIGN_KEY" ]]; then
    # GPG 签名
    info "签名方式: GPG"
    if gpg --list-keys "$SIGN_KEY" &>/dev/null 2>&1; then
      pass "GPG 签名密钥可用: $SIGN_KEY"
    else
      fail "GPG 签名密钥不可用: $SIGN_KEY"
    fi
  fi

elif [[ "$GPG_SIGN" == "false" ]]; then
  # 签名关闭，不是致命问题（可用 --no-gpg-sign），但值得提示
  warn "commit 签名未开启 (commit.gpgsign=false)"
  info "临时绕过: git commit --no-gpg-sign"
else
  warn "commit.gpgsign 未配置 — 取决于全局设置，如有问题可用 --no-gpg-sign"
fi

# ================================================================
# 2. 项目依赖
# ================================================================
header "2. 项目依赖"

if [[ -d node_modules ]]; then
  pass "node_modules 存在"
else
  fail "node_modules 不存在 — 运行 npm install"
fi

if [[ -d vendor/sha ]]; then
  pass "vendor/sha 子模块存在"
else
  fail "vendor/sha 子模块未检出 — 运行 git submodule update --init"
fi

# ================================================================
# 摘要
# ================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║             诊断摘要                              ║"
echo "╠══════════════════════════════════════════════════╣"
printf "║  通过: %-2d   警告: %-2d   失败: %-2d             ║\n" "$PASS" "$WARN" "$FAIL"
echo "╚══════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo " 发现 $FAIL 个致命问题，请修复后再开发。"
  exit 1
else
  echo ""
  echo " 一切正常，开发环境就绪。"
  exit 0
fi

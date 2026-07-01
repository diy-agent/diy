#!/usr/bin/env bash
# diy-clirpc 开发脚本入口
#
# ── 命令结构 ────────────────────────────────────
# ./sha.sh clean         清理
# ./sha.sh check         ruff 检查
# ./sha.sh fix           ruff 自动修复
# ./sha.sh sync          依赖同步
# ./sha.sh test          pytest 全部
# ./sha.sh demo          演示
#   connect              ConnectRPC
#   h2rpc                HTTP/2

set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

PKG="src/cli_rpc"

# ════════════════════════════════════════════════════════════

clean() {
  run rm -rf ./build ./dist ./.pytest_cache ./.ruff_cache
  run find . -type d -name "*.egg-info" -prune -exec rm -rf {} \;
}

check() {
  run uv run ruff check "$PKG" src/tests/
  run uv run ruff format --check "$PKG" src/tests/
}

fix() {
  run uv run ruff check --fix "$PKG" src/tests/
  run uv run ruff format "$PKG" src/tests/
}

sync() {
  run uv sync
}

test() {
  run uv run python -m pytest "$PKG/test_cli_rpc.py" -v
  echo "---"
  run uv run python -m pytest src/tests/ -v
}

# ════════════════════════════════════════════════════════════
# 演示
# ════════════════════════════════════════════════════════════

demo() {
  connect() {
    run bash "$PKG/transport/connectrpc/demo.sh"
  }
  h2rpc() {
    run bash "$PKG/transport/http2/demo.sh"
  }
  if [[ $# -eq 0 ]]; then
    echo "演示命令"
    echo "  connect   ConnectRPC"
    echo "  h2rpc     HTTP/2"
  fi
}

# ════════════════════════════════════════════════════════════

sha "$@"

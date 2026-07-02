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
# 生成代码 + 演示
# ════════════════════════════════════════════════════════════

gen() {
  run uv run python demo/proto_gen.py
  run cd demo/gen && buf generate
}

demo() {
  connect() {
    run bash "demo/connectrpc_demo.sh"
  }
  h2rpc() {
    run bash "demo/http2_demo.sh"
  }
  typed() {
    run uv run uvicorn demo.connect_servicer:app --host 127.0.0.1 --port 8322
  }
  typed-test() {
    run uv run python demo/test_connect.py
  }
  gen-all() {
    run uv run python demo/proto_gen.py
    run cd demo/gen && buf generate
    echo "✓ 全部生成完成"
  }
  if [[ $# -eq 0 ]]; then
    echo "演示命令"
    echo "  connect     ConnectRPC"
    echo "  h2rpc       HTTP/2"
    echo "  typed       类型安全 RPC 服务端"
    echo "  typed-test  闭环测试"
  fi
}

# ════════════════════════════════════════════════════════════

sha "$@"

#!/usr/bin/env bash
#
# diy-llm 脚本入口
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 命令可嵌套：函数内再定义函数 → `./sha.sh foo bar`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run uv run pytest`
# 4. 可用颜色变量：$primary $secondary $error $info $reset
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#
# ── 示例 ─────────────────────────────────────────
#   ./sha.sh auth set ...   # 注册密钥
#   ./sha.sh sync           # 同步模型列表
#   ./sha.sh sync-models    # 手动同步模型列表（不走 mono sync）
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

####################################################################################
# mono 必备子命令
####################################################################################
sync() { unlink ; link; }
link() {  run uv tool install -e ./ ; }
unlink() {  if command -v diy-llm; then  uv tool uninstall diy-llm; fi;}


clean() {
  run rm -rf ./build
  run rm -rf ./dist
  run rm -rf ./.pytest_cache
  run rm -rf ./.ruff_cache
  run rm -rf ~/.diy-llm/locks/
  run find . -type d -name "*.egg-info" -prune -exec rm -rf {} \;
}

check() {
  run uv run ruff check src/ tests/
  run uv run ruff format --check src/ tests/
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}

test() { :; }
test-all() { test; }

####################################################################################
# diy-llm 子命令
####################################################################################

#  ./sha.sh auth set ...    注册密钥
#  ./sha.sh sync-models     手动同步模型列表（不走 mono sync）
#  ./sha.sh run ...         透传任意命令到 uv run (由 sha.common.sh 提供)

auth()        { run uv run diy-llm auth "$@"; }
sync-models() { run uv run diy-llm sync "$@"; }
model()       { run uv run diy-llm model "$@"; }

sha "$@"

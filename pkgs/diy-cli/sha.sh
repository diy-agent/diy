#!/usr/bin/env bash
#
# diyui.py 开发脚本入口
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
# build() {
#   subcommand() { run echo "subcommand"; }
#   run npm run build
# }
# 调用：./sha.sh build subcommand
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

# Get the real path of the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

####################################################################################
# mono必备子命令
####################################################################################

clean() {
  run rm -rf ./build
  run rm -rf ./dist
  run rm -rf ./.pytest_cache
  run rm -rf ./.ruff_cache
  run find . -type d -name "*.egg-info" -prune -exec rm -rf {} \;
}


check() {
  run uv run ruff check src/ tests/
  run uv run ruff format --check src/ tests/
  run uv run pyright src/ tests/
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}
sync() { unlink ; link; }
link() {  run uv tool install -e ./ ; }
unlink() {  if command -v diy; then  uv tool uninstall diy-cli; fi;}

test() { :; }
#  ./sha.sh test-headless
test-headless() { :;}
# 有头模式 + slowmo 500ms，可以看着浏览器执行
test-head() { :;}
# unit test
test-all() { test; test-headless;}

####################################################################################
# 子项目自己的命令
####################################################################################

panel() {  run uv run panel serve --dev --show examples/*.pn.py; }


sha "$@"

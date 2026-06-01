#!/usr/bin/env bash
#
# diy-ui 开发脚本入口
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
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"
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
  run uv run pyright src/ tests/ examples/
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}
ci() { check;test-all; }
sync() { :; }
test() { run uv run pytest "${@:-tests/}" -m "not browser";}

test-headless() { run uv run pytest -v --browser chromium tests/browser/test*.py ;}
# 有头模式 + slowmo 500ms，可以看着浏览器执行
test-head() { run uv run pytest -v --browser chromium --headed --slowmo 500 tests/browser/test*.py ;}
# unit test
test-all() { test; test-headless;}

####################################################################################
# 子项目自己的命令
####################################################################################

examples() {  run uv run panel serve --dev examples/*.pn.py; }

# Panel 诊断工具：适配列表 / 参数一致性 / 签名查询
# 用法: ./sha.sh panel list             # 组件适配列表
#       ./sha.sh panel list -g widgets  # 仅 widgets
#       ./sha.sh panel doctor           # 参数一致性诊断
#       ./sha.sh panel query -n Button
example-marimo() {
  run uv run marimo edit --watch examples 
}
doctor() {
  run uv run python tools/doctor_panel.py "$@"
}


sha "$@"

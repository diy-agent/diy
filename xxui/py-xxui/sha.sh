#!/usr/bin/env bash
#
# py-xxui 开发脚本入口
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 命令可嵌套：函数内再定义函数 → `./sha.sh foo bar`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run uv run pytest`
# 4. 可用颜色变量：$primary $secondary $error $info $reset
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha_common.sh → source vendor/sha/sha.bash
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
source "../../sha_common.sh"

####################################################################################
# GitHub Project 工作流配置
####################################################################################

clean() {
  run rm -rf ./build
  run rm -rf ./dist
}



#  # 单个测试（精确路径）                                                                                                                       
#  ./sha.sh test-head "tests/test_browser.py::TestButtonClickToCellRerun::test_increment_button_updates_counter"
#                        
#  # 按名字匹配（-k 模糊）                                                                                                                      
#  ./sha.sh test-head -k "counter"
#                                                                                                      
#  # 整个测试类                                                                                                                                 
#  ./sha.sh test-head -k "TestButtonClickToCellRerun"
#                                                                                   
#  # 无参数 = 全部 15 个                                                                                                                        
#  ./sha.sh test-headless                                                                                                                   
test-headless() {
  local test_args="${@:-tests/test_browser.py}"
  run uv run pytest -v --browser chromium $test_args 
}
test-head() {
  # 有头模式 + slowmo 500ms，可以看着浏览器执行
  local test_args="${@:-tests/test_browser.py}"
  run uv run pytest -v --browser chromium --headed --slowmo 500 $test_args
}
test-unit() {
  run uv run pytest "${@:-tests/}" -m "not browser"
}
test() {
  test-unit
  test-headless
}

check() {
  run uv run ruff check src/ tests/
  run uv run ruff format --check src/ tests/
  run uv run pyright src/ tests/ examples/
  test-unit "$@"
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}

panel() {
  run uv run panel serve --dev --show examples/*.pn.py
}




sha "$@"


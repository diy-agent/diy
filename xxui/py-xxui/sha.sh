#!/usr/bin/env bash
#
# py-xxui 开发脚本入口
#
# 命令：
#   test [args]  - 运行 pytest
#   check        - ruff lint + format check + test
#   fix          - ruff 自动修复
#   panel        - 启动 Panel 示例服务
#   clean        - 清理 build/dist
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

test() {
  run uv run pytest "${@:-tests/}"
}

check() {
  run uv run ruff check src/ tests/
  run uv run ruff format --check src/ tests/
  test "$@"
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}

panel() {
  run uv run panel serve examples/*.pn.py
}
####################################################
# app entry script & _root cmd
####################################################

sha "$@"


#!/usr/bin/env bash
# 01-basic: 函数名即命令
#
# 试：
#   bash examples/01-basic.bash --help     # 列出 build / run_tests（_helper 不出现）
#   bash examples/01-basic.bash build      # -> "build default"
#   bash examples/01-basic.bash run_tests  # 单个 _ 不拆分，整体就是一个命令
#   bash examples/01-basic.bash _helper    # -> unknown command（_ 开头不注册）

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha.bash"

build() { echo "build default"; }

run_tests() { echo "run all tests"; }

_helper() { echo "you should never reach here via sha"; }

sha "$@" || exit $?

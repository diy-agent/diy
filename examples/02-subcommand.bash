#!/usr/bin/env bash
# 02-subcommand: `.` 与 `__` 都是层级分隔符，可混用；余下参数全透给实现函数
#
# 试：
#   bash examples/02-subcommand.bash --help            # build/ run_tests
#   bash examples/02-subcommand.bash build --help      # web ios
#   bash examples/02-subcommand.bash build             # 父命令自己有实现 -> "build default"
#   bash examples/02-subcommand.bash build web         # -> "build web"
#   bash examples/02-subcommand.bash build ios         # __ 同样是分层 -> "build ios"
#   bash examples/02-subcommand.bash build web --target macos --release
#     # 贪心最长匹配命中 "build web"，后面参数原样透传

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha.bash"

build() { echo "build default"; }
build.web() { echo "build web args: $*"; }
build__ios() { echo "build ios args: $*"; }

run_tests() { echo "run all tests"; }

sha "$@" || exit $?

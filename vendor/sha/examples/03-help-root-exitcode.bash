#!/usr/bin/env bash
# 03-help-root-exitcode: root() / help / 退出码
#
# 试（注意退出码）：
#   bash examples/03-help-root-exitcode.bash; echo "rc=$?"
#     # 无参 -> root() 存在则执行它 -> "i am root"，rc=0
#   bash examples/03-help-root-exitcode.bash --help; echo "rc=$?"
#     # 根 help，rc=0（g/ 结尾的是纯分组）
#   bash examples/03-help-root-exitcode.bash g; echo "rc=$?"
#     # g 自己没有函数，只有子命令 -> 打印该组 help，rc=3
#   bash examples/03-help-root-exitcode.bash g g1; echo "rc=$?"
#     # -> "g/g1"，rc=0
#   bash examples/03-help-root-exitcode.bash g bad; echo "rc=$?"
#     # 纯分组下的未知子命令，rc=1
#   bash examples/03-help-root-exitcode.bash no_such; echo "rc=$?"
#     # 未知命令，rc=1

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha.bash"

root() { echo "i am root"; }

g.g1() { echo "g/g1"; }
g.g2() { echo "g/g2"; }

sha "$@" || exit $?

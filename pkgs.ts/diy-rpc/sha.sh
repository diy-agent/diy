#!/usr/bin/env bash
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
# mono必备子命令（根 ./sha.sh check/fix/test/test-unit 组装这些）
####################################################################################

clean() {
  run rm -rf ./build ./dist
}

check() { run npm run check; }
fix() { run npm run fix; }

sync() { :; }

# 本包全是快速单测，无慢测试：test ≡ test-unit
test() { run npm run test; }
test-unit() { run npm run test; }

####################################################################################
# 子项目自己的命令
####################################################################################


sha "$@"

#!/usr/bin/env bash
#
# ts-xxui 开发脚本入口
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 命令可嵌套：函数内再定义函数 → `./sha.sh foo bar`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
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
# ts-xxui 开发工作流
####################################################################################

clean() {
  run rm -rf ./dist
}

# check：类型检查
check() {
  run npx tsc --noEmit
}

# test：运行 vitest 单元测试
#   ./sha.sh test                       # 全部测试
#   ./sha.sh test tests/cell.test.ts    # 单个测试文件
test() { run npx vitest run "${@:-}"; }

# ci：check + test
ci() { check; test; }

# fix：代码格式化
fix() {
  run npx prettier --write 'src/**/*.ts' 'tests/**/*.ts' 'tools/**/*.ts' 'examples/**/*.ts'
}

sha "$@"

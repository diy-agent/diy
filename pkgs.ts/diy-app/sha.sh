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
  run rm -rf ./out ./build ./dist
}

# 本包检查：类型 + lint（全仓 check 另含 rpc 浏览器安全）
check() { run npm run check; }
# 本包自动修复：格式化 + lint 可修项
fix() { run npm run fix; }
sync() { :; }

# 本包构建：main + preload + renderer + cli（根 build 调这个）
build() {
  run npm run build
  run npm run build:cli
}

# 本包全部测试：快速单测 → 构建 → 意图测试（起隔离 Electron，慢）
test() {
  test-unit
  build
  # 按前缀全收 tests/cli.intent.*：不点名文件，新增用例自动纳入；
  # 包脚本 test:intent 同口径（点名文件表易过期，2026-09 已改前缀收法）
  run npx vitest run --no-file-parallelism tests/cli.intent
}
# 编程中快速验证：不构建，跳过意图测试
test-unit() { run npm run test:unit; }

####################################################################################
# 子项目自己的命令
####################################################################################


sha "$@"

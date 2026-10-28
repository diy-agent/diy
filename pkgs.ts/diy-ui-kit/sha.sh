#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 命令可嵌套：函数内再定义函数 → `./sha.sh foo bar`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 4. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

####################################################################################
# mono必备子命令（根 ./sha.sh check/fix/test/test-unit 组装这些）
####################################################################################

clean() {
  run rm -rf ./build ./dist
}

# 本包检查：类型 + lint
check() {
  typecheck
  lint
}
fix() {
  fmt-fix
  lint-fix
}

sync() { :; }

# 本包无单测（纯展示组件，行为由 diy-app 的意图测试覆盖）
test() { :; }
test-unit() { :; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/; }
lint-fix() { run npx oxlint --fix src/; }
fmt() { run npx oxfmt --check src/; }
fmt-fix() { run npx oxfmt --write src/; }

sha "$@"

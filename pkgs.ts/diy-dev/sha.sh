#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 3. 可用颜色变量：$primary $secondary $error $info $reset
# 4. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#
# ── 说明 ────────────────────────────────────────
# 全部命令原是 package.json scripts（2026-09 迁入，package.json 不再管理脚本）。
# 全部用 npx 直调本地 .bin（原来 npm run 隐式提供的 PATH，外面自己加 npx）。
# 命令间依赖直接调函数（如 check 调 typecheck），不再经 npm run 中转。
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

# 本包检查：类型 + lint
check() {
  typecheck
  lint
}
# 本包自动修复：格式化 + lint 可修项
fix() {
  fmt-fix
  lint-fix
}

sync() { :; }

build() { run npx vite build --config vite.cli.config.ts; }

# 本包全是快速单测，无慢测试：test ≡ test-unit
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

####################################################################################
# 子项目自己的命令（原 package.json scripts）
####################################################################################

# 开发期跑 CLI 源码：./sha.sh dev <args>（cwd 即作用域，不 cd）
dev() { run npx tsx src/cli/index.ts "$@"; }
test-watch() { run npx vitest "$@"; }
typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/; }
lint-fix() { run npx oxlint --fix src/; }
fmt() { run npx oxfmt --check src/; }
fmt-fix() { run npx oxfmt --write src/; }


sha "$@"

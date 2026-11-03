#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 3. 文件末尾保留 `sha "$@"` 调度入口
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"

clean() {
  run rm -rf ./build ./dist ./lib
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

# 本包全是快速单测：test ≡ test-unit
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

test-watch() { run npx vitest "$@"; }
# build：把 src/ 编成 lib/（Node 可直接 import 的 ESM + .d.ts，见 tsconfig.build.json）
build() { run npx tsc -p tsconfig.build.json; }
typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
fmt() { run npx oxfmt --check src/ tests/; }
fmt-fix() { run npx oxfmt --write src/ tests/; }

sha "$@"

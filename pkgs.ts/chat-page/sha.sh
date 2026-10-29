#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash → sha "$@"
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

clean() { run rm -rf ./build ./dist ./lib; }
check() { typecheck; lint; }
fix() { fmt-fix; lint-fix; }
sync() { :; }
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

build() { run npx tsc -p tsconfig.build.json; }
typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
fmt() { run npx oxfmt --check src/ tests/; }
fmt-fix() { run npx oxfmt --write src/ tests/; }

sha "$@"

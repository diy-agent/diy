#!/usr/bin/env bash
#
# 本包的 mono 入口（根 ./sha.sh check/fix/test 靠它发现这个包）。
# 纯 Node 包：没有 Electron、没有构建前置，测试都是快单测。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"

clean() {
  run rm -rf ./build ./dist ./lib ./node_modules/.cache/tsbuildinfo ./tsconfig.tsbuildinfo
}

sync() { :; }

check() {
  typecheck
  lint
}
fix() {
  fmt-fix
  lint-fix
}

test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

test-watch() { run npx vitest "$@"; }

# build：src/ → dist/（Node 可直接 import 的 ESM + .d.ts）
build() { run npx tsc -p tsconfig.build.json; }
typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
fmt() { run npx oxfmt --check src/ tests/; }
fmt-fix() { run npx oxfmt --write src/ tests/; }

sha "$@"

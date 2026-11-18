#!/usr/bin/env bash
#
# 本包的 mono 入口（根 `./sha.sh check` 靠它发现这个包）。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"

clean() { run rm -rf ./dist ./examples/dist ./node_modules/.cache/tsbuildinfo ./tsconfig.tsbuildinfo; }

sync() { :; }

check() {
  typecheck
  lint
  test
}
fix() {
  fmt-fix
  lint-fix
}

test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }
test-watch() { run npx vitest "$@"; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/ examples/; }
lint-fix() { run npx oxlint --fix src/ tests/ examples/; }
fmt() { run npx oxfmt --check src/ tests/ examples/; }
fmt-fix() { run npx oxfmt --write src/ tests/ examples/; }

# ── 例子（examples/ 自带 vite 工程，不依赖任何 app）────────────────────────
#
# 为什么写死根的 vite 而不用 `npx vite`：npm 会向上找到本包的 package.json 当 workspace
# 根，于是 vite 的 root 变成包目录、examples/index.html 一个都找不到（实测）。
dev() { ( cd examples && run "$__SHA_COMMON_DIR/node_modules/.bin/vite" "$@" ); }

examples() { ( cd examples && run "$__SHA_COMMON_DIR/node_modules/.bin/vite" build ); }

sha "$@"

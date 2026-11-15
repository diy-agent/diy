#!/usr/bin/env bash
#
# 本包的 mono 入口（`./sha.sh exec` / `clean` / 各包 `check` 靠它发现这个包）。
# 传输层目前没有单测（HTTP/SSE 的覆盖缺口见 PR 说明）。
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

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/; }
lint-fix() { run npx oxlint --fix src/; }
fmt() { run npx oxfmt --check src/; }
fmt-fix() { run npx oxfmt --write src/; }

sha "$@"

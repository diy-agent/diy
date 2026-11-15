#!/usr/bin/env bash
#
# 本 app 的 mono 入口（`./sha.sh exec` / `clean` / 各包 `check` 靠它发现这个包）。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

clean() {
  run rm -rf ./dist ./node_modules/.cache/tsbuildinfo ./tsconfig.tsbuildinfo
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
lint() { run npx oxlint src/ server/; }
lint-fix() { run npx oxlint --fix src/ server/; }
fmt() { run npx oxfmt --check src/ server/; }
fmt-fix() { run npx oxfmt --write src/ server/; }

sha "$@"

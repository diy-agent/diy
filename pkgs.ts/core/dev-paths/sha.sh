#!/usr/bin/env bash
# pkgs.ts/core/dev-paths — dev 运行目录唯一真源（##518）
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"

clean() { run rm -rf ./lib ./node_modules/.cache/tsbuildinfo; }
sync() { :; }
build() {
  run npx tsc -p tsconfig.build.json
  # 发行形态 package.json（exports 指 lib/*.js、去 private）—— build-pkgs 也会做一遍，幂等
  run node ../../../scripts/npm-publish.mjs . --prepare-only --out=lib
}
typecheck() { run npx tsc -p tsconfig.json; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
test() { run npx vitest run "$@"; }
test-unit() { test "$@"; }
check() { typecheck; lint; }
fix() { lint-fix; }
publish() { run node ../../../scripts/npm-publish.mjs . --out=lib "$@"; }

sha "$@"

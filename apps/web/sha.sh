#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash → sha "$@"
#
# 产物按变体分根：build/<variant>/web/{server.mjs,renderer/{index.html,index.js}}
# 没有 electron 产物：本 app 是「无 Electron 的 web 宿主」（##485 判据 6）。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

export DIY_VARIANT="${DIY_VARIANT:-lab}"
_repo_root() { ( cd "$SCRIPT_DIR/../.." && pwd ); }

clean() { run rm -rf ./build ./dist ./lib; }
check() { typecheck; lint; }
fix() { fmt-fix; lint-fix; }
sync() { :; }
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

# 构建（只编本 app 的产物；能力包 lib/ 由启动器按需补编，见 main.mjs）
build() { run node ./main.mjs --build-only; }

# 起服务：./sha.sh lab --port 8080 [--home …]
lab() { run node ./main.mjs --port "${PORT:-8080}" "$@"; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint .; }
lint-fix() { run npx oxlint --fix .; }
fmt() { run npx oxfmt --check .; }
fmt-fix() { run npx oxfmt --write .; }

sha "$@"

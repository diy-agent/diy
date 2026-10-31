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

####################################################################################
# 发布（npm → 发行形态）
#
# 仓内 package.json 的 main/exports 指 src/*.ts 且带 private:true 当护栏；发行物另生成在 lib/
# （分发逻辑见 scripts/npm-publish.mjs）。认证：NPM_PUBLISH_TOKEN（环境变量，或 ~/.bashrc 里那份，
# 脚本自己找，不必先 source）。仓内依赖写的 `*` 会在发布时改成 `^<仓内版本>`。
####################################################################################

# publish：build 后发布到 npm（加 --dry-run 只演练：打包 + 校验，不上传）
publish() {
  build
  run node ../../scripts/npm-publish.mjs . --out=lib "$@"
}

sha "$@"

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
  run rm -rf ./build ./dist ./lib
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

# 本包全是快速单测，无慢测试：test ≡ test-unit
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

####################################################################################
# 子项目自己的命令（原 package.json scripts）
####################################################################################

test-watch() { run npx vitest "$@"; }
# build：把 src/ 编成 lib/（Node 可直接 import 的 ESM + .d.ts，见 tsconfig.build.json）
# 为什么必须编：Electron 从 node_modules 动态加载能力包时 Node 加载不了 `.ts`（##453 判据①）
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

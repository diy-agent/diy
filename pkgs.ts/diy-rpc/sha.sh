#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. `:` 在 bash 函数名非法，原 scripts 的 `:` 用 `-` 代替：`check:browser` → `./sha.sh check-browser`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 4. 可用颜色变量：$primary $secondary $error $info $reset
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#
# ── 说明 ────────────────────────────────────────
# 全部命令原是 package.json scripts（2026-09 迁入，package.json 不再管理脚本）。
# 全部用 npx 直调本地 .bin（原来 npm run 隐式提供的 PATH，外面自己加 npx）。
# 命令间依赖直接调函数（如 check 调 typecheck），不再经 npm run 中转。
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

# 本包检查：类型 + lint + 浏览器安全（禁 node:/fs/path/electron 等 import）
check() {
  typecheck
  lint
  check-browser
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

typecheck() { run npx tsc --noEmit; }
# 浏览器安全：本包纯 TS，禁 Node/Electron 特有 API（新增依赖后必跑）
check-browser() { run npx tsc --noEmit -p tsconfig.browser.json; }
test-watch() { run npx vitest "$@"; }
lint() { run npx oxlint src/ test/; }
lint-fix() { run npx oxlint --fix src/ test/; }
fmt() { run npx oxfmt --check src/ test/; }
fmt-fix() { run npx oxfmt --write src/ test/; }

####################################################################################
# 发布（npm → @diy-agent/rpc）
#
# 仓内 package.json 的 main/exports 指 src/*.ts（workspace 内部 vite 直接吃源码）且带
# private:true 当护栏；发行物另生成在 lib/（分发逻辑见 scripts/npm-publish.mjs）。
# 认证：NPM_PUBLISH_TOKEN（环境变量，或 ~/.bashrc 里那份；脚本自己找，不必先 source）
####################################################################################

# build：编译 lib（ESM + d.ts）并生成发行版 package.json
build() {
  run npx tsc -p tsconfig.build.json
  run node ../../scripts/npm-publish.mjs . --prepare-only --out=lib
}
# publish：build 后发布到 npm（加 --dry-run 只演练：打包 + 校验，不上传）
publish() {
  build
  run node ../../scripts/npm-publish.mjs . --out=lib "$@"
}


sha "$@"

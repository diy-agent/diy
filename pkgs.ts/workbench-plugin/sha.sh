#!/usr/bin/env bash
#
# ts-pkgs-workbench-plugin 开发脚本入口
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 命令可嵌套：函数内再定义函数 → `./sha.sh foo bar`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 4. 可用颜色变量：$primary $secondary $error $info $reset
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

# Get the real path of the script directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"
source "../../sha.common.sh"

####################################################################################
# ts-pkgs-workbench-plugin 开发工作流
####################################################################################

clean() {
  run rm -rf ./dist ./lib
}
sync() {
  :
}

# check：类型检查
check() {
  run npx tsc --noEmit
}

####################################################################################
# 发布（npm → @diy-agent/workbench-plugin）
#
# 仓内 package.json 的 main/exports 指 src/*.ts 且带 private:true 当护栏；
# 发行物另生成在 lib/（分发逻辑见 scripts/npm-publish.mjs）。
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

# test：运行 vitest 单元测试
test() { run npx vitest run "${@:-}"; }
test-unit() { run npx vitest run "$@"; }

# ci：check + test
ci() {
  check
  test
}

sha "$@"

#!/usr/bin/env bash
#
# pkgs.ts/ui/design 的构建脚本
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../../sha.common.sh → source vendor/sha/sha.bash → sha "$@"
#
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"
source "$SCRIPT_DIR/../../../vendor/sha/sha.bash"

####################################################################################
# mono必备子命令（根 ./sha.sh clean / sync 会对**每个** workspace 调这两个）
# 缺了会直接让整条根命令中止：`ERROR: unknown command [clean]`
####################################################################################

#: 清生成中间目录
#: 只删 .gen/（esbuild 打的中间产物，已 gitignore）；src/gen/*.css 是**提交的**派生物，
#: 删了要重跑 gen 才有，且 `./sha.sh check` 还依赖它作基线 ⇒ 不在这里删。
clean() {
  run rm -rf ./.gen
}

#: 本包无外部依赖可同步（material-color-utilities 由根 npm i 装）
sync() { :; }

#: 从 seed 重新生成 src/gen/*.css（material-color-utilities → CSS）
#: 为什么要 esbuild 先打一遍：那个包发的是**无扩展名 ESM**，node 直接跑会 ERR_MODULE_NOT_FOUND。
gen() {
  run npx esbuild scripts/gen.mts --bundle --platform=node --format=esm --outfile=.gen/gen.mjs
  run node .gen/gen.mjs
}

#: 生成物是否与脚本一致（生成到临时目录再逐字节比；不一致 ⇒ 退出码 1）
#: 用法: ./sha.sh check
check() {
  local tmp; tmp="$(mktemp -d)"
  cp -r src/gen "$tmp/gen"
  gen >/dev/null
  local bad=0
  for f in "$tmp"/gen/*.css; do
    local base; base="$(basename "$f")"
    if ! cmp -s "$f" "src/gen/$base"; then
      echo "${err}生成物已过期：src/gen/$base（跑 ./sha.sh gen 更新）${reset}"
      bad=1
    fi
  done
  rm -rf "$tmp"
  [ "$bad" = 0 ] && echo "${info}生成物与脚本一致${reset}"
  return "$bad"
}

sha "$@"

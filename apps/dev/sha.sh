#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash → sha "$@"
#
# 产物按变体分根：build/<variant>/{main,preload,renderer}
# 数据根在**仓库根** build/<variant>/home（与 pkgs.ts 各包同一约定）
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

export DIY_VARIANT="${DIY_VARIANT:-lab}"
_build_dir() { echo "build/${DIY_VARIANT}"; }
_repo_root() { ( cd "$SCRIPT_DIR/../.." && pwd ); }

clean() { run rm -rf ./build ./dist ./lib; }
check() { typecheck; lint; }
fix() { fmt-fix; lint-fix; }
sync() { :; }
test() { run npx vitest run "$@"; }
test-unit() { run npx vitest run "$@"; }

# electron 二进制就绪（全机 store + 本 worktree 软链；缺则下）
_ensure_electron() { run node ../../scripts/ensure-electron.mjs --quiet; }

# 依赖包先编 lib：主进程按包名 import、renderer 打包读 exports，都指向 lib/*.js
build-deps() {
  local pkg
  # diy-time 必须先于 diy-remote（后者 tsc 引用前者的 .d.ts）
  for pkg in workbench ui-workbench diy-time diy-remote; do
    ( cd "$SCRIPT_DIR/../../pkgs.ts/$pkg" && ./sha.sh build )
  done
}

build() {
  run npx tsc -p tsconfig.build.json
  build-deps
  build-main
  build-preload
  build-renderer
}

build-main() {
  local d; d="$(_build_dir)"
  # @diy-agent/* 保持外部：运行时按包名解析（真插件边界）
  run npx esbuild main.ts --bundle --platform=node --format=esm --target=node22 \
    --external:electron "--external:@diy-agent/*" --outfile="$d/main/index.mjs"
}

build-preload() {
  local d; d="$(_build_dir)"
  # sandbox 下的 preload 只能是 CJS；只外置 electron
  run npx esbuild preload.ts --bundle --platform=node --format=cjs --target=node22 \
    --external:electron --outfile="$d/preload/index.cjs"
}

build-renderer() {
  local d; d="$(_build_dir)"
  run npx esbuild renderer.ts --bundle --platform=browser --format=iife --target=es2022 \
    --outfile="$d/renderer/index.js"
  run mkdir -p "$d/renderer"
  run cp index.html "$d/renderer/index.html"
}

# 开发实例：构建后直接起（lab 变体自带 CDP 9223）
lab() {
  _ensure_electron
  build
  local d; d="$(_build_dir)"
  local home; home="$(_repo_root)/build/$DIY_VARIANT/home"
  run mkdir -p "$home"
  echo "${info}数据根：$home${reset}"
  run env DIY_HOME="$home" DIY_VARIANT="$DIY_VARIANT" DIY_ENV=development npx electron "$d/main/index.mjs" "$@"
}

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint .; }
lint-fix() { run npx oxlint --fix .; }
fmt() { run npx oxfmt --check .; }
fmt-fix() { run npx oxfmt --write .; }

sha "$@"

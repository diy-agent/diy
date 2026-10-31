#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash → sha "$@"
#
# 产物按变体分根：build/<variant>/{main,preload}
#   main/index.mjs      主进程（esbuild ESM；electron 与 @diy-agent/* 走运行时解析）
#   preload/shell.cjs   远程页面那一侧的桥（只读当前位置）
#   preload/bar.cjs     横条页那一侧的桥（读状态 / 切换 / 重新发现 / 布局自述）
# 没有 renderer 产物：横条 HTML 内联在 bar.ts，用 data: URL 加载。
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

build() {
  run npx tsc -p tsconfig.build.json
  build-main
  build-preload
}

build-main() {
  local d; d="$(_build_dir)"
  # @diy-agent/* 保持外部：发现器包（##479 @diy-agent/remote）是运行时动态 import 的，
  # 打进 bundle 会在包尚未合入时直接构建失败（本壳要能独立跑）。
  run npx esbuild main.ts --bundle --platform=node --format=esm --target=node22 \
    --external:electron "--external:@diy-agent/*" --outfile="$d/main/index.mjs"
}

build-preload() {
  local d; d="$(_build_dir)"
  # sandbox 下的 preload 只能是 CJS；只外置 electron
  run npx esbuild preload.ts --bundle --platform=node --format=cjs --target=node22 \
    --external:electron --outfile="$d/preload/shell.cjs"
  run npx esbuild bar-preload.ts --bundle --platform=node --format=cjs --target=node22 \
    --external:electron --outfile="$d/preload/bar.cjs"
}

# 开发实例：构建后直接起。lab 变体下 main.ts 自带 CDP 9222。
#   ./sha.sh lab --url http://127.0.0.1:8080
lab() {
  _ensure_electron
  build
  local d; d="$(_build_dir)"
  local home; home="$(_repo_root)/build/$DIY_VARIANT/home"
  run mkdir -p "$home"
  echo "${info}数据根：$home${reset}"
  run env DIY_HOME="$home" DIY_VARIANT="$DIY_VARIANT" npx electron "$d/main/index.mjs" "$@"
}

# ##481 判据实测：起两个假远程实例 + 真 Electron + CDP
#   1 能起（--url）· 2 横条显示 displayName/状态 · 3 横条不被远程页面覆盖（布局自述）
#   4 切换 + 切回来状态还在 · 5 远程断开横条变红 · 6 列表来自发现链（manual 兜底）
#
# 用 `node`（Node ≥22.18 自带类型剥离）而不是 tsx：tsx 走 esbuild，keepNames 会给
# 函数加上 `__name(...)` 包装，而 `page.evaluate(fn)` 是把函数 **序列化** 进页面执行的 ——
# 页面上没有 `__name`，直接 ReferenceError。node 类型剥离只删类型，函数源码原样过去。
verify() {
  _ensure_electron
  build
  run env DIY_VARIANT="$DIY_VARIANT" node scripts/verify.mts
}

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint .; }
lint-fix() { run npx oxlint --fix .; }
fmt() { run npx oxfmt --check .; }
fmt-fix() { run npx oxfmt --write .; }

sha "$@"

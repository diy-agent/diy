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
# 产物与变体**解耦**：tsc + esbuild 只跟源码有关 ⇒ 一份 `build/app/`；
# 变体只决定运行空间（数据根 `build/<variant>/home`、DIY_ENV、CDP / 副屏）
_build_dir() { echo "build/app"; }
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
  # diy-ui 不能省：chat-page 的 renderer-diui 入口依赖 `@diy-agent/ui/browser`（##468）
  # 顺序 = 依赖顺序：tsc 的 project references 要求被引包 lib/ 已存在（TS6305）。
  # ##512 起 pkgs.ts 分层：下面全是**仓相对目录**（不再是 pkgs.ts/<dirname>）
  for pkg in core/log core/time agent/session agent/store-jsonl agent/store-memory model/provider model/catalog agent/tools agent/jobs agent/compaction agent/bot ui/workbench ui/workbench-ui ui/core ui/chat-page ui/model-config ui/bot-config; do
    ( cd "$SCRIPT_DIR/../../pkgs.ts/$pkg" && ./sha.sh build )
  done
}

# 本 app build = 四包 lib（tsc）+ 三个产物（esbuild）
build() {
  run npx tsc -p tsconfig.build.json
  build-deps
  build-main
  build-preload
  build-renderer
}

build-main() {
  local d; d="$(_build_dir)"
  # @diy-agent/* 保持外部：运行时按包名解析（真插件边界，不把插件打成一个巨型 bundle）
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

# 开发实例：构建后直接起（无 HMR —— 这一刀只验链路）。lab 变体下 main.ts 自带 CDP 9222。
#
# **缺省内存**（2026-11-05 用户裁：「除了 model 配置、bot 配置，其他都要内存化」）：
# 会话历史 / meta / 压缩状态全在进程里，重启即清零；`$DIY_HOME` 只写 bots/。
# 加 `--persist` 切文件版（会话历史落 jsonl），用于对照验证 / 排障。
lab() {
  _ensure_electron
  build
  local d; d="$(_build_dir)"
  local persist=""
  local args=()
  for a in "$@"; do
    if [ "$a" = "--persist" ]; then persist="1"; else args+=("$a"); fi
  done
  # 数据根：**只有 dev 启动器拉起时**才认注入的 DIY_HOME（它带了 DIY_LAUNCH）；
  # 手工跑时 shell 里残留的 DIY_HOME（如生产 ~/.diy）绝不能把人带进生产数据根
  local home; home="${DIY_LAUNCH:+${DIY_HOME:-}}"; home="${home:-$(_repo_root)/build/$DIY_VARIANT/home}"
  run mkdir -p "$home"
  if [ -n "$persist" ]; then
    echo "${info}数据根：$home（文件版：会话历史落 jsonl）${reset}"
  else
    echo "${info}数据根：$home（内存版：bots 以外不落盘）${reset}"
  fi
  run env DIY_HOME="$home" DIY_VARIANT="$DIY_VARIANT" ${persist:+DIY_CHAT_PERSIST=1} npx electron "$d/main/index.mjs" ${args[@]+"${args[@]}"}
}

# ##468 渲染层判据：CDP 实测 1–6（不闪 / 滚动不跳 / 焦点不丢 / 切会话外壳不重建）
#   ./sha.sh verify-render          # 期望 diui 版
#   RENDERER=dom ./sha.sh verify-render  # 期望裸 DOM 版（切回 import 重新 build 后）
verify-render() {
  _ensure_electron
  build
  run env DIY_VARIANT="$DIY_VARIANT" npx tsx scripts/verify-render.mts
}

# 冒烟：起实例 + 走一遍「输入一句话 → 看到用户消息与固定回复」的判据
smoke() {
  _ensure_electron
  build
  run env DIY_VARIANT="$DIY_VARIANT" npx tsx scripts/smoke.mts
}

build-lib() { run npx tsc -p tsconfig.build.json; }
typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint .; }
lint-fix() { run npx oxlint --fix .; }
fmt() { run npx oxfmt --check .; }
fmt-fix() { run npx oxfmt --write .; }

# ── 发布（npm → @diy-agent/app-chat）─────────────────────────────────────────
# 发行形态 = bin/（CLI 入口）+ build/（esbuild 产物）+ 生成的 package.json，由
# scripts/npm-publish-app.mjs 组装到 dist/；仓内 package.json 的 private:true 只是护栏。
# publish：build → 组装 dist → npm publish（--dry-run 只演练）
dist() { build; run node ../../scripts/npm-publish-app.mjs . --prepare-only --variant "$DIY_VARIANT" "$@"; }
publish() { build; run node ../../scripts/npm-publish-app.mjs . --variant "$DIY_VARIANT" "$@"; }

sha "$@"

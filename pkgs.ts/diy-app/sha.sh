#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. `:` 在 bash 函数名非法，原 scripts 的 `:` 用 `-` 代替：`build:renderer` → `./sha.sh build-renderer`
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
# 命令间依赖直接调函数（如 build 调 build-renderer），不再经 npm run 中转。
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
  run rm -rf ./out ./build ./dist
}

# 本包检查：类型 + lint（全仓 check 另含 rpc 浏览器安全，见根 sha.sh）
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

# 本包构建：main + preload + renderer（根 build 调这个；cli 产物另见 build-cli）
build() {
  run npx vite build --config vite.main.config.ts
  run npx vite build --config vite.preload.config.ts
  run npx vite build --config vite.cli.config.ts
  build-renderer
}

# 本包全部测试：快速单测 → 构建 → 意图测试（起隔离 Electron，慢）
test() {
  test-unit
  # 按前缀全收 tests/cli.intent.*：不点名文件，新增用例自动纳入
  test-intent
}
# 编程中快速验证：不构建，跳过意图测试
test-unit() { run npx vitest run --exclude '**/cli.intent*'; }

####################################################################################
# 子项目自己的命令（原 package.json scripts）
####################################################################################

# 开发模式：renderer dev server + watch main/preload + electron（透传参数，如 --port 18888）
dev() { run npx tsx scripts/electron-dev.mts "$@"; }
# 开发期跑 CLI 源码：./sha.sh cli task list
cli() { run npx tsx src/cli/index.ts "$@"; }
# 纯 Web 服务（先构建 renderer，透传参数，如 --port <port>）
serve() {
  build-renderer
  run npx tsx src/serve/index.ts "$@"
}
serve-build() {
  build-renderer
  run npx vite build --config vite.serve.config.ts
}
build-cli() { run npx vite build --config vite.cli.config.ts; }
build-renderer() { run npx vite build --config vite.renderer.config.ts; }
# 运行生产构建（先构建）
start() {
  build
  run npx electron out/main/index.mjs "$@"
}
link() { run npm link; }

test-watch() { run npx vitest "$@"; }
# 意图测试：先构建（起隔离 Electron，最慢放最后）
test-intent() {
  build
  run npx vitest run --no-file-parallelism tests/cli.intent "$@"
}

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
fmt() { run npx oxfmt --check src/ tests/; }
fmt-fix() { run npx oxfmt --write src/ tests/; }

# 打包：先构建（透传 electron-builder 参数）
dist() {
  build
  run npx electron-builder "$@"
}
dist-mac() {
  build
  run npx electron-builder --mac "$@"
}
dist-linux() {
  build
  run npx electron-builder --linux "$@"
}
dist-win() {
  build
  run npx electron-builder --win "$@"
}

icon() { run python3 scripts/gen-icon.py; }


sha "$@"

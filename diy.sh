#!/usr/bin/env bash
# diy.sh — worktree 开发入口（测试约定 ./diy.sh，cwd=仓库根）。
#
# 机制（与 src/runtime.ts / src/cli/index.ts / src/main/index.ts 契约一致）：
#   1. CLI：直接用 tsx 跑源码 src/cli/index.ts（无需构建，改完即生效）
#   2. GUI：CLI 通过 ensureAppPort() 复用或拉起 Electron 产物
#      out/main/index.mjs + out/preload/index.js + out/renderer/index.html
#      → GUI 必须先构建才会存在，未构建直接报错（见下方检查）
#   3. dev 模式另走：cd pkgs.ts/diy-app && npm run dev
#      起 Vite dev server 并注入 DIY_DEV_SERVER_URL，走 loadURL 热更新（HMR），无需 build
#   4. 数据隔离：DIY_HOME 默认 ./build/home（本 worktree 独立），注入后由
#      src/runtime.ts readRuntimeConfig() 统一读取；测试用 mkdtemp 隔离
#   5. 发布入口：pkgs.ts/diy-app/bin/diy 跑编译产物 out/cli/index.js，数据落 ~/.diy
#
# 前置要求：首次使用或改动 main/preload/renderer 后，需先构建：
#   cd pkgs.ts/diy-app && npm run build
# 否则 out/main/index.mjs 不存在，CLI 会在 stderr 提示并退出（不污染 stdout JSON）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/pkgs.ts/diy-app"
HOME_DEFAULT="$SCRIPT_DIR/build/home"
mkdir -p "$HOME_DEFAULT"

# 前置检查：GUI 产物必须存在（CLI 本身是 tsx 源码无需构建，但要拉起的 Electron 必须已构建）
if [[ ! -f "$APP_DIR/out/main/index.mjs" ]]; then
  echo "[diy.sh] 未找到 Electron 产物: $APP_DIR/out/main/index.mjs" >&2
  echo "[diy.sh] 机制: CLI(tsx 源码) 需拉起 GUI 产物(out/main)才能响应 RPC" >&2
  echo "[diy.sh] 请先构建: cd pkgs.ts/diy-app && npm run build" >&2
  echo "[diy.sh] 或开发模式（HMR，无需 build）: cd pkgs.ts/diy-app && npm run dev" >&2
  exit 1
fi

# 机制提示（仅交互终端输出到 stderr，不污染 --json 的 stdout）
if [[ -t 2 ]]; then
  echo "[diy.sh] CLI=tsx源码 | GUI=out/main产物 | HOME=${DIY_HOME:-$HOME_DEFAULT} | 需先 build（dev 模式除外）" >&2
fi

cd "$APP_DIR"
exec env DIY_HOME="${DIY_HOME:-$HOME_DEFAULT}" \
  "$APP_DIR/../../node_modules/.bin/tsx" src/cli/index.ts "$@"
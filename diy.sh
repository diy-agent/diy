#!/usr/bin/env bash
# diy.sh — worktree 开发入口（测试约定 ./diy.sh，cwd=仓库根）。
#
# 用途：跑未编译源码 CLI（tsx），数据隔离到本 worktree 的 build/home。
# 注入：DIY_HOME — 供 JS 侧 src/runtime.ts readRuntimeConfig() 读取装配。
# 发布/全局入口见 pkgs.ts/diy-app/bin/diy（跑编译产物）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/pkgs.ts/diy-app"
HOME_DEFAULT="$SCRIPT_DIR/build/home"
mkdir -p "$HOME_DEFAULT"

cd "$APP_DIR"
exec env DIY_HOME="${DIY_HOME:-$HOME_DEFAULT}" \
  "$APP_DIR/../../node_modules/.bin/tsx" src/cli/index.ts "$@"
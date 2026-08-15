#!/usr/bin/env bash
# diy.sh — 本地 diy-app CLI 入口（替代全局 diy2 / diy-app）
#
# 定位到本仓库根目录，进入 diy-app，调用 bin/diy.mjs。
# 开发（默认）用 tsx 跑源码；生产 NODE_ENV=production 跑编译产物 out/cli/index.js。
# 意图测试等场景用 ./diy.sh 代替全局命令，避免 PATH / 全局安装不一致的问题。
#
# 用法:
#   ./diy.sh task list
#   ./diy.sh task create 标题 /path/to/subject
#   ./diy.sh --help

set -euo pipefail

# 脚本自身真实路径所在目录（本仓库根）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/pkgs.ts/diy-app"

cd "$APP_DIR"
exec node bin/diy.mjs "$@"

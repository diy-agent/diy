#!/usr/bin/env bash
# diy.sh — 当前 worktree 的 dev CLI 入口（TS diy-app）
#
# 定位到本仓库根目录，进入 diy-app，调用 bin/diy.mjs。
# 开发（默认）用 tsx 跑源码；生产 NODE_ENV=production 跑编译产物 out/cli/index.js。
#
# 数据隔离：
#   默认 DIY_HOME=./build/home（本 worktree 独立），自动 mkdir -p。
#   已设 DIY_HOME 时尊重外部传入（测试用 mkdtemp 隔离，不会被覆盖）。
#   多 worktree 并存时各用各的 build/home，不共享 ~/.diy。
#
# 测试约定：
#   本 worktree 的所有命令行测试直接用 ./diy.sh（cwd=仓库根），无需拦截改写。
#   - TS 意图测试（pkgs.ts/diy-app/tests/）的 ShellTest 默认 cwd=仓库根，./diy.sh 自然可执行
#   - Python 侧 tests/conftest.py 的 fast_commands 拦截仅服务 Python 包（dai），与本脚本无关
#
# 用法:
#   ./diy.sh task list
#   ./diy.sh task create 标题 /path/to/subject
#   ./diy.sh --help
#
set -euo pipefail

# 脚本自身真实路径所在目录（本仓库根）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/pkgs.ts/diy-app"

# 每个 worktree 独立数据目录，避免多 worktree 共享 ~/.diy 互相踩
DIY_HOME_DEFAULT="$SCRIPT_DIR/build/home"
mkdir -p "$DIY_HOME_DEFAULT"

cd "$APP_DIR"
exec env DIY_HOME="${DIY_HOME:-$DIY_HOME_DEFAULT}" node bin/diy.mjs "$@"

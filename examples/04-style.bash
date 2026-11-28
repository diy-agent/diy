#!/usr/bin/env bash
# 04-style: sha_style.bash 独立演示（只管颜色，不管分发）
#
# 试：
#   bash examples/04-style.bash
#
# 注意：不要在同一个进程里同时 source sha.bash 和 sha_style.bash，
# 否则 use_theme / test_sha_style 会被注册成 sha 命令（它们不带 _ 前缀）。
# 样式只在需要彩色输出的脚本里单独 source。

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha_style.bash"

use_theme dark
echo -e "${ui_primary} PRIMARY ${reset} <- 自动配白字"
echo -e "${ui_warning} WARNING ${reset} <- 自动配黑字"
echo -e "${ui_error} ERROR ${reset} <- 自动配白字"
echo -e "${ui_fg}standard text in dark mode${reset}"

use_theme light
echo -e "${ui_fg}now switched to dark text${reset}"

#!/usr/bin/env bash
# shellcheck disable=SC2329  # 忽略函数未被使用的警告
# shellcheck disable=SC2034  # primary appears unused. Verify use (or export if used externally).shellcheckSC2034
## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar

# On Mac OS, readlink -f doesn't work, so use._real_path get the real path of the file
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/" && pwd)

# --- 1. M3 原子颜色 (Raw Components) ---
# Primary Colors
m3_primary="48;5;55"
m3_on_primary="38;5;255"
m3_primary_container="48;5;117"
m3_on_primary_container="38;5;15"
m3_primary_fixed="48;5;117"
m3_primary_fixed_dim="48;5;81"
m3_on_primary_fixed="38;5;15"
m3_on_primary_fixed_variant="38;5;30"

# Secondary Colors
m3_secondary="48;5;66"
m3_on_secondary="38;5;255"
m3_secondary_container="48;5;153"
m3_on_secondary_container="38;5;15"
m3_secondary_fixed="48;5;153"
m3_secondary_fixed_dim="48;5;117"
m3_on_secondary_fixed="38;5;15"

# Tertiary Colors
m3_tertiary="48;5;23"
m3_on_tertiary="38;5;255"
m3_tertiary_container="48;5;189"
m3_on_tertiary_container="38;5;15"
m3_tertiary_fixed="48;5;189"
m3_tertiary_fixed_dim="48;5;153"
m3_on_tertiary_fixed="38;5;15"

# Surface Colors
m3_surface="48;5;234"
m3_on_surface="38;5;255"
m3_surface_dim="48;5;229"
m3_surface_bright="48;5;248"
m3_surface_container="48;5;237"
m3_surface_container_lowest="48;5;233"
m3_surface_container_low="48;5;235"
m3_surface_container_medium="48;5;240"
m3_surface_container_high="48;5;243"
m3_surface_container_highest="48;5;246"
m3_surface_variant="48;5;243"
m3_on_surface_variant="38;5;244"
m3_inverse_surface="48;5;255"
m3_inverse_on_surface="38;5;16"

# Background
m3_background="48;5;234"
m3_on_background="38;5;255"

# Error Colors
m3_error="48;5;124"
m3_on_error="38;5;255"
m3_error_container="48;5;162"
m3_on_error_container="38;5;15"

# Other Roles
m3_outline="38;5;244"
m3_outline_variant="38;5;248"
m3_inverse_primary="38;5;16"
m3_scrim="38;5;0"
m3_shadow="38;5;0"

# 语义原子
m3_success="48;5;28"
m3_on_success="38;5;255"
m3_warning="48;5;214"
m3_on_warning="38;5;16"
m3_info="48;5;31"
m3_on_info="38;5;255"

# 顶层合成色直接可用 (ANSI SGR格式: \033[fg;bg;attrm)
_color_compose() {
    printf "\033[%s;%s;1m" "$1" "$2"
}

primary=$(_color_compose "$m3_on_primary" "$m3_primary")
secondary=$(_color_compose "$m3_on_secondary" "$m3_secondary")
tertiary=$(_color_compose "$m3_on_tertiary" "$m3_tertiary")
success=$(_color_compose "$m3_on_success" "$m3_success")
error=$(_color_compose "$m3_on_error" "$m3_error")
warning=$(_color_compose "$m3_on_warning" "$m3_warning")
info=$(_color_compose "$m3_on_info" "$m3_info")
surface=$(_color_compose "$m3_on_surface" "$m3_surface")
surface_container=$(_color_compose "$m3_on_surface" "$m3_surface_container")
surface_variant=$(_color_compose "$m3_on_surface_variant" "$m3_surface_variant")
inverse_surface=$(_color_compose "$m3_inverse_on_surface" "$m3_inverse_surface")
outline="\033[${m3_outline}m"
reset=$(printf '\033[0m')
creset=$(printf '\033[0m')

# 清晰的函数调用日志，替代 `set -x` 功能
#
# Usage:   _run <some cmd>
# Example: _run docker compose up
#
# 假设你的./sake 脚本里有个函数：
# up() {
#   _run docker compose up;  # ./sake 的 22行
# }
# 运行`./sake up`后打印日志：
# 🔵 ./sake:22 up() ▶︎【/home/ubuntu/current_work_dir$ docker compose up】
# 你可以清晰的看到:
#   - 在脚本的哪一行: ./sake:22
#   - 哪个函数: up()
#   - 在哪个工作目录: /home/ubuntu/current_work_dir
#   - 执行了什么: docker compose up
# 在vscode中，按住macbook的cmd键,点终端上输出的‘./sake:106’, 可以让编辑器跳转到对应的脚本行，很方便
# 获取调用栈的原理：
#   `caller 0`输出为`22 foo ./sake`，即调用_run函数的调用栈信息：行号、函数,脚本
run() {
  local caller_script=$(caller 0 | awk '{print $3}')
    # shellcheck disable=SC2001
  local caller_script=$(echo "$caller_script" | sed "s@^$HOME@~@" )

  local caller_line=$(caller 0 | awk '{print $1}')
  # 把 /home/ubuntu/current_work_dir 替换为 ~/current_work_dir 短格式
  # 使用 @ 作为分隔符，避免与路径中的 / 冲突
  # shellcheck disable=SC2001
  local current_pwd=$(echo "$PWD" | sed "s@^$HOME@~@" )
  local color_caller="${secondary}${caller_script}:${caller_line} ${FUNCNAME[1]}() ${reset}"
  local color_pwd="${info}${current_pwd} ${reset}"

  # 只给包含空格的参数加上引号，方便复制粘贴
  local quoted_cmd=""
  for arg in "$@"; do
    if [[ "$arg" == *" "* ]]; then
      quoted_cmd+="\"$arg\" "
    else
      quoted_cmd+="$arg "
    fi
  done
  # 移除末尾多余的空格
  quoted_cmd="${quoted_cmd% }"

  local color_cmd="${primary}${quoted_cmd}${reset}"
  echo "$color_caller$color_pwd$color_cmd" >&2
  "$@"
}

# run pwd
# shellcheck source=../vendor/sha.bash
if [ ! -d "$ROOT_DIR/vendor/sha" ] || [ -z "$(ls -A "$ROOT_DIR/vendor/sha" 2>/dev/null)" ]; then
  echo "${info} vendor/sha等子模块初始化不存在, 开始初始化... ${reset}"
  run git submodule update --init --recursive
fi
source "$ROOT_DIR/vendor/sha/sha.bash"
shopt -s expand_aliases  # bash默认不开启alias 扩展

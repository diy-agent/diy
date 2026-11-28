#!/usr/bin/env bash
# 06-doc-help: 帮助写在函数注释里（不用 sha.desc 逐条注册）
#
# 约定：紧邻函数定义行上方、连续、以 `#:` 开头的注释块
#   #: 一句话说明        ← 块首行 = desc（子命令列表 + help 顶部）
#   #: 用法: sha …        ← "用法:" / "usage:" 前缀行 = usage（写了就盖过自动生成的那行）
#   #: 其余行             ← detail
#   普通 `#` 是实现备注，不算帮助（避免误吞）
#
# 试：
#   bash examples/06-doc-help.bash --help
#     # 一层列表：build / deploy 后面直接是注释首行
#   bash examples/06-doc-help.bash -hh
#     # -h 叠写 = 整棵树，子命令缩进列在父命令下方
#   bash examples/06-doc-help.bash build -h
#     # desc + usage + detail + options
#   bash examples/06-doc-help.bash deploy -h
#     # 只有注释也能出完整 help（无需任何 sha.* 注册）
#   bash examples/06-doc-help.bash deploy prod
#     # 执行命令本身

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha.bash"
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha_opt.bash"

#: 构建全部产物
#: 用法: sha build [--target T]
#: 默认构建 macos target；web 子命令只管 web 包。
build() {
  local target=macos
  local -a FILES=()        # --arg "FILES..." 声明的名字，直接当数组用
  sha.parse "$@" || return $?
  echo "target=$target files=${FILES[*]}"
}

#: 只构建 web 包
build.web() {
  echo "web: build.web"
}

#: 部署到目标环境
#: 用法: sha deploy <ENV>
#: ENV 取 prod / staging；其余值直接报错。
#: 本命令没有 sha.option 注册，但用 --arg 声明了位置参数（下面）。
deploy() {
  local ENV=""               # --arg "ENV!" 声明的名字（标量）
  sha.parse "$@" || return $?
  case $ENV in
    prod | staging) echo "deploy -> $ENV" ;;
    *)
      echo "ERROR: unknown env [$ENV]（取值见 --help）" >&2
      return 1
      ;;
  esac
}

sha.option "build" "--target:string=macos:目标平台"
sha.def "build" --arg "FILES...:输入文件"
sha.def "deploy" --arg "ENV!:目标环境"

# 普通 # 注释不算帮助：所以 cfg 在列表里只有名字、没有说明
cfg() { echo "cfg"; }

sha "$@" || exit $?

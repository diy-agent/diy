#!/usr/bin/env bash
# 05-opt-help: option + help 结合（sha.def 一次调用定义完一个命令的全部元数据）
#
# 试：
#   bash examples/05-opt-help.bash --help
#     # 根树，build 后带 desc
#   bash examples/05-opt-help.bash build -h
#     # 完整 help：usage（由 options/args 自动生成）+ desc + options + commands，不进函数
#   bash examples/05-opt-help.bash build --mode fast -h
#     # -h 放选项后面同样生效（-- 之前预扫）
#   bash examples/05-opt-help.bash build --mode fast --target linux --release --jobs 8 ./a ./b
#     # target=linux mode=fast release=1 jobs=8 files=./a ./b
#   bash examples/05-opt-help.bash build web pkg ./a ./b
#     # 单个必填位置参数 + 变长：name=pkg files=./a ./b
#   bash examples/05-opt-help.bash build web
#     # ERROR: missing argument <NAME> for [build web] + usage，rc=1
#   bash examples/05-opt-help.bash build --target linux --release
#     # ERROR: option [--mode] is required，rc=1
#   bash examples/05-opt-help.bash build --mode turbo
#     # ERROR: option [--mode] must be one of fast|safe, got [turbo]，rc=1
#   bash examples/05-opt-help.bash build --mode fast -- --help
#     # -- 之后全是位置参数：files=--help，rc=0

EXAMPLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha.bash"
# shellcheck disable=SC1091
source "$EXAMPLE_DIR/../sha_opt.bash"

# sha.def 的参数顺序约定：--opt / --arg 在前，--desc 放最后一行
#   （多行文案不夹在中间，改起来不会被上下夹住；首行进列表，其余行进 help）
sha.def "build" \
  --opt "-t,--target:string=macos:目标平台" \
  --opt "--mode:string![fast|safe]:运行模式" \
  --opt "--release:bool:优化构建" \
  --opt "--jobs:int=4:并行数" \
  --opt "--src:list:源码目录(可重复)" \
  --arg "FILES...:输入文件（变长：一个名字吃剩余全部，声明成 local -a FILES）" \
  --desc "构建包
备注：mode 必填；--target 缺席时取 macos。"

# 单个位置参数：--arg "NAME!"（带 ! 为必填）→ 函数里 local NAME 直接当标量用
sha.def "build web" \
  --opt "--target:string=macos:目标平台" \
  --arg "NAME!:包名（必填，单个）" \
  --arg "FILES...:输入文件（选填，多个）" \
  --desc "构建 web 包"

sha.def "*" \
  --opt "--verbose:bool:详细输出"

# 命令体里只做两件事：声明变量 + 一行 sha.parse
#   sha.def 声明了什么就只解析什么：
#     选项        -> 同名 local 变量（如 target / mode / release）
#     位置参数    -> --arg 里声明的名字（FILES... -> 数组 local -a FILES）
#   没声明的选项 / 没声明就传位置参数，一律报错并打 usage
build() {
  local target mode release jobs verbose
  local -a src=() FILES=()
  sha.parse "$@" || return $?
  echo "target=$target mode=$mode release=$release jobs=$jobs verbose=$verbose src=${src[*]} files=${FILES[*]}"
}

build.web() {
  local target verbose
  local NAME=""           # --arg "NAME!"：单个必填位置参数
  local -a FILES=()      # --arg "FILES..."：变长，吃剩余全部
  sha.parse "$@" || return $?
  echo "web target=$target verbose=$verbose name=$NAME files=${FILES[*]}"
}

sha "$@" || exit $?

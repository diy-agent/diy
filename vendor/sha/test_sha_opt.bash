#!/usr/bin/env bash
# test_sha_opt.bash: sha.option 的意图测试。规范即此文件头部的 PEG，
# 每个用例注释里就是定义原文；docs/OPT-CASES.md 已被本文件取代。
#
# 规范 (PEG, 唯一正解, 与 sha_opt.bash 头部完全一致):
#   spec       <- opt-head ":" type ("=" default)? ("!")? enum-block? (":" help)?
#   opt-head   <- (short ",")? longopt
#   short      <- "-" [A-Za-z0-9]
#   longopt    <- "--" identifier
#   identifier <- [a-zA-Z][a-zA-Z0-9_-]*
#   type       <- "string" / "int" / "bool" / "list"
#   default    <- (!("!" / "[" / ":") .)+
#   enum-block <- "[" literal ("|" literal)* "]"
#   literal    <- (!( "|" / "]" / ":" ) .)+
#   help       <- .*
# 语义约束见 S15-S24；帮助是最后一个 ":" 之后的全剩余文本 (S10)。
set -o errtrace
set -o errexit
set -o functrace
set -o pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEST_PATH=$(basename "$TEST_DIR")

# shellcheck disable=SC1091
source "$TEST_DIR/unit_test_framework.bash"
# shellcheck disable=SC1091
source "$TEST_DIR/sha.bash"
# shellcheck disable=SC1091
source "$TEST_DIR/sha_opt.bash"

# 每个用例在子 shell 跑：注册表变更不出用例，天然隔离。
# 约定：合法用例断言 rc=0 + 落表字段；非法用例断言 rc=1 + 报错片段。

# S1 长名 + 默认值 + 说明
# sha.option "build" "--target:string=macos:目标平台"
test_S01_long_default_help() {
  local out rc=0
  out=$(sha.option "build" "--target:string=macos:目标平台" 2>&1 \
    && printf '|type=%s|def=%s|help=%s|order=%s' \
      "${_SHA_OPT_TYPE[build|target]}" "${_SHA_OPT_DEFAULT[build|target]}" \
      "${_SHA_OPT_HELP[build|target]}" "${_SHA_OPT_ORDER[build]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=string" "$out"
  assert_contains "def=macos" "$out"
  assert_contains "help=目标平台" "$out"
  assert_contains "order=target" "$out"
}

# S2 短名 + 长名
# sha.option "build" "-t,--target:string=macos:目标平台"
test_S02_short_long() {
  local out rc=0
  out=$(sha.option "build" "-t,--target:string=macos:目标平台" 2>&1 \
    && printf '|short=%s' "${_SHA_OPT_SHORT[build|t]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "short=target" "$out"
}

# S3 必填无枚举
# sha.option "build" "--token:string!:鉴权 token"
test_S03_required() {
  local out rc=0
  out=$(sha.option "build" "--token:string!:鉴权 token" 2>&1 \
    && printf '|req=%s' "${_SHA_OPT_REQUIRED[build|token]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "req=1" "$out"
}

# S4 必填 + 枚举
# sha.option "build" "--mode:string![fast|safe]:运行模式"
test_S04_required_enum() {
  local out rc=0
  out=$(sha.option "build" "--mode:string![fast|safe]:运行模式" 2>&1 \
    && printf '|req=%s|enum=%s' "${_SHA_OPT_REQUIRED[build|mode]}" "${_SHA_OPT_ENUM[build|mode]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "req=1" "$out"
  assert_contains "enum=fast|safe" "$out"
}

# S5 选填 + 枚举：不写 ! 就是“可以不填”，缺席时空串，枚举只校验出现的值
# sha.option "build" "--mode:string[fast|safe]:运行模式"
test_S05_optional_enum() {
  local out rc=0
  out=$(sha.option "build" "--mode:string[fast|safe]:运行模式" 2>&1 \
    && printf '|req=%s|enum=%s|hasdef=%s' "${_SHA_OPT_REQUIRED[build|mode]}" \
      "${_SHA_OPT_ENUM[build|mode]}" "${_SHA_OPT_HAS_DEFAULT[build|mode]:-0}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "req=0" "$out"
  assert_contains "enum=fast|safe" "$out"
  assert_contains "hasdef=0" "$out"
}

# S5b 哨兵默认值：显式的“未选”状态
# sha.option "build" "--mode:string=auto[auto|fast|safe]:运行模式"
test_S05b_sentinel_default() {
  local out rc=0
  out=$(sha.option "build" "--mode:string=auto[auto|fast|safe]:运行模式" 2>&1 \
    && printf '|def=%s' "${_SHA_OPT_DEFAULT[build|mode]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "def=auto" "$out"
}

# S6 bool（裸 --x / --no-x；短名不合写）
# sha.option "build" "--release:bool:优化构建"
# sha.option "build" "-r,--release:bool:优化构建"
test_S06_bool() {
  local out rc=0
  out=$(sha.option "build" "--release:bool:优化构建" "-r,--verbose:bool:详细" 2>&1 \
    && printf '|type=%s|short=%s' "${_SHA_OPT_TYPE[build|release]}" "${_SHA_OPT_SHORT[build|r]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=bool" "$out"
  assert_contains "short=verbose" "$out"
}

# S7 int + 默认值
# sha.option "build" "--jobs:int=4:并行数"
test_S07_int_default() {
  local out rc=0
  out=$(sha.option "build" "--jobs:int=4:并行数" 2>&1 \
    && printf '|type=%s|def=%s' "${_SHA_OPT_TYPE[build|jobs]}" "${_SHA_OPT_DEFAULT[build|jobs]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=int" "$out"
  assert_contains "def=4" "$out"
}

# S8 list（重复追加，无默认值）
# sha.option "build" "--src:list:源码目录(可重复)"
test_S08_list() {
  local out rc=0
  out=$(sha.option "build" "--src:list:源码目录(可重复)" 2>&1 \
    && printf '|type=%s|hasdef=%s' "${_SHA_OPT_TYPE[build|src]}" "${_SHA_OPT_HAS_DEFAULT[build|src]:-0}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=list" "$out"
  assert_contains "hasdef=0" "$out"
}

# S9 长名含 -，变量名 - 转 _
# sha.option "build" "--dry-run:bool:试运行"
test_S09_dash_to_underscore() {
  local out rc=0
  out=$(sha.option "build" "--dry-run:bool:试运行" 2>&1 \
    && printf '|var=%s' "${_SHA_OPT_ORDER[build]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "var=dry_run" "$out"
}

# S10 help 含冒号 / 省略 help
# sha.option "build" "--addr:string:格式为 host:port"
# sha.option "build" "--jobs:int=4"
test_S10_help_colon_or_empty() {
  local out rc=0
  out=$(sha.option "build" "--addr:string:格式为 host:port" "--jobs:int=4" 2>&1 \
    && printf '|h1=%s|h2=%s' "${_SHA_OPT_HELP[build|addr]}" "${_SHA_OPT_HELP[build|jobs]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "h1=格式为 host:port" "$out"
  assert_contains "h2=" "$out"
}

# S11 help 多行（字面换行）
# sha.option "build" "--src:list:源码目录(可重复)<换行>第二行：支持相对路径"
test_S11_help_multiline() {
  local spec="--src:list:源码目录(可重复)
第二行：支持相对路径"
  local out rc=0
  out=$(sha.option "build" "$spec" 2>&1 \
    && printf '|help=%s' "${_SHA_OPT_HELP[build|src]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "源码目录(可重复)" "$out"
  assert_contains "第二行：支持相对路径" "$out"
}

# S12 嵌套命令路径
# sha.option "build web" "--target:string=macos:目标平台"
test_S12_nested_cmd() {
  local out rc=0
  out=$(sha.option "build web" "--target:string=macos:目标平台" 2>&1 \
    && printf '|type=%s' "${_SHA_OPT_TYPE[build web|target]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=string" "$out"
}

# S13 分两次注册合并
# sha.option "build" "--target:string=macos:目标平台"
# sha.option "build" "--jobs:int=4:并行数"
test_S13_merge_calls() {
  local out rc=0
  out=$(sha.option "build" "--target:string=macos:目标平台" 2>&1 \
    && sha.option "build" "--jobs:int=4:并行数" 2>&1 \
    && printf '|order=%s' "${_SHA_OPT_ORDER[build]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "order=target jobs" "$out"
}

# S14 全局选项（注册在文件顶层；子 shell 会继承父表，故本用例只读断言不重复注册）
test_S14_global() {
  local out rc=0
  out=$(printf '|type=%s' "${_SHA_OPT_TYPE[*|verbose]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=bool" "$out"
}

# S15 长名缺 -- 前缀
# sha.option "build" "target:string=macos:目标平台"
test_S15_no_dash_prefix() {
  local out rc=0
  out=$(sha.option "build" "target:string=macos:目标平台" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "--" "$out"
}

# S16 bool 加 ! / = / 枚举
# sha.option "build" "--release:bool!:优化构建"
# sha.option "build" "--release:bool=1:优化构建"
# sha.option "build" "--release:bool[yes|no]:优化构建"
test_S16_bool_extras() {
  local out rc=0
  out=$(sha.option "build" "--release:bool!:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
  rc=0
  out=$(sha.option "build" "--release:bool=1:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
  rc=0
  out=$(sha.option "build" "--release:bool[yes|no]:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
}

# S17 必填又给默认值
# sha.option "build" "--mode:string=x!:运行模式"
test_S17_required_with_default() {
  local out rc=0
  out=$(sha.option "build" "--mode:string=x!:运行模式" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "required" "$out"
}

# S18 未知类型 / 缺类型
# sha.option "build" "--ratio:float:比例"
# sha.option "build" "--target"
test_S18_bad_or_missing_type() {
  local out rc=0
  out=$(sha.option "build" "--ratio:float:比例" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  rc=0
  out=$(sha.option "build" "--target" 2>&1) || rc=$?
  assert_equals "1" "$rc"
}

# S19 非法名字（长名 / 短名单字符 / 短名无长名）
# sha.option "build" "--1x:string:坏名字"
# sha.option "build" "-tt,--x:string:短名超长"
# sha.option "build" "-t"  -> 短名必须配长名
test_S19_bad_names() {
  local out rc=0
  out=$(sha.option "build" "--1x:string:坏名字" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "非法" "$out"
  rc=0
  out=$(sha.option "build" "-tt,--x:string:短名超长" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "短选项" "$out"
  rc=0
  out=$(sha.option "build" "-t,--x:string:ok" "-t,--y:string:dup" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "短选项" "$out"
}

# S20 保留名 --help / -h
# sha.option "build" "--help:string:帮助"
# sha.option "build" "-h,--head:string:头"
test_S20_reserved() {
  local out rc=0
  out=$(sha.option "build" "--help:string:帮助" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "保留" "$out"
  rc=0
  out=$(sha.option "build" "-h,--head:string:头" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "保留" "$out"
}

# S21 重复与映射撞车
# sha.option "build" "-t,--target:string=macos:甲" "-n,--target:string=linux:乙"
# sha.option "build" "--dry-run:bool:甲" "--dry_run:bool:乙"
test_S21_dup_and_collision() {
  local out rc=0
  out=$(sha.option "build" "-t,--target:string=macos:甲" "-n,--target:string=linux:乙" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "重复" "$out"
  rc=0
  out=$(sha.option "build" "--dry-run:bool:甲" "--dry_run:bool:乙" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "dry_run" "$out"
}

# S22 分两次注册同一选项
# sha.option "build" "--target:string=macos:甲"
# sha.option "build" "--target:string=linux:乙"
test_S22_dup_across_calls() {
  local out rc=0
  out=$(sha.option "build" "--target:string=macos:甲" 2>&1 \
    && sha.option "build" "--target:string=linux:乙" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "重复" "$out"
}

# S23 默认值校验（枚举归属 / 空枚举 / 空默认 / int 非整数）
test_S23_default_checks() {
  local out rc=0
  out=$(sha.option "build" "--mode:string=turbo[fast|safe]:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "枚举" "$out"
  rc=0
  out=$(sha.option "build" "--mode:string[]:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "枚举" "$out"
  rc=0
  out=$(sha.option "build" "--token:string=:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "默认值" "$out"
  rc=0
  out=$(sha.option "build" "--jobs:int=abc:并行数" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "整数" "$out"
}

# S24 list 默认值 / 全局必填
# sha.option "build" "--src:list=a,b:源码目录"
# sha.option "*" "--token:string!:鉴权"
test_S24_list_default_global_required() {
  local out rc=0
  out=$(sha.option "build" "--src:list=a,b:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "list" "$out"
  rc=0
  out=$(sha.option "*" "--token:string!:鉴权" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "全局" "$out"
}

# S25 全局与命令短名撞车（双向），同变量名则允许（命令优先）
# NOTE: 用 -q/--ques/--quux 全新名字——文件顶层已注册 demo/-t 与 */--verbose，
# 子 shell 会继承父表，用旧名字会在冲突检测前先撞上“重复定义”
test_S25_short_clash_global() {
  local out rc=0
  out=$(sha.option "build" "-q,--ques:string:x" 2>&1 \
    && sha.option "*" "-q,--quux:bool:y" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "冲突" "$out"
  rc=0
  out=$(sha.option "*" "-q,--quux:bool:y" 2>&1 \
    && sha.option "build" "-q,--ques:string:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "冲突" "$out"
  rc=0
  out=$(sha.option "build" "-q,--ques:string:x" 2>&1 \
    && sha.option "*" "-q,--ques:string:y" 2>&1 \
    && printf '|ok=%s' "${_SHA_OPT_SHORT[*|q]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "ok=ques" "$out"
}

# S26 sha.def 一次调用：desc + opt（usage 由 opt 自动生成，不再有 --usage）
test_S26_def_full() {
  local out rc=0
  out=$(sha.def "svc" \
    --desc "服务管理" \
    --opt "--port:int=8080:端口" 2>&1 \
    && printf '|type=%s|def=%s|desc=%s' \
      "${_SHA_OPT_TYPE[svc|port]}" "${_SHA_OPT_DEFAULT[svc|port]}" \
      "${_SHA_DESC[svc]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "type=int" "$out"
  assert_contains "def=8080" "$out"
  assert_contains "desc=服务管理" "$out"
  # --usage 已移除：现在算 unknown option
  rc=0
  out=$(sha.def "svc" --usage "x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unknown option" "$out"
}

# S27 sha.def：--desc 多行（首行 desc + 其余 detail）+ 多个 opt（含短名）+ 等号形式
test_S27_def_detail_multi() {
  local out rc=0
  out=$(sha.def "svc web" \
    --desc=$'web 服务\n备注：端口必填。' \
    --opt="-p,--port:string!:端口" \
    --opt="--release:bool:优化构建" 2>&1 \
    && printf '|desc=%s|detail=%s|req=%s|short=%s' \
      "${_SHA_DESC[svc web]}" "${_SHA_DETAIL[svc web]}" \
      "${_SHA_OPT_REQUIRED[svc web|port]}" "${_SHA_OPT_SHORT[svc web|p]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "desc=web 服务" "$out"
  assert_contains "detail=备注" "$out"
  assert_contains "req=1" "$out"
  assert_contains "short=port" "$out"
  # --detail 已移除：合并进 --desc 多行
  rc=0
  out=$(sha.def "svc" --detail "x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unknown option" "$out"
}

# S28 sha.def 未知参数（走同一套 unknown option 报错）
test_S28_def_unknown_flag() {
  local out rc=0
  out=$(sha.def "svc" --bogus x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unknown option" "$out"
}

# S29 sha.def 行尾缺值
test_S29_def_missing_value() {
  local out rc=0
  out=$(sha.def "svc" --desc 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "requires a value" "$out"
}

# S30 sha.def 透传校验：坏 spec / 多行 desc 照拦
test_S30_def_passthrough_errors() {
  local out rc=0
  out=$(sha.def "svc" --opt "--release:bool=1:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
  # --desc 多行现在是合法的：首行 desc，其余 detail
  rc=0
  out=$(sha.def "svc" --desc "$(printf 'a\nb')" 2>&1 \
    && printf '|desc=%s|detail=%s' "${_SHA_DESC[svc]}" "${_SHA_DETAIL[svc]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "desc=a" "$out"
  assert_contains "detail=b" "$out"
}

# S31 sha.def 无参数：静默成功（占位）
test_S31_def_empty() {
  local out rc=0
  out=$(sha.def "svc" 2>&1) || rc=$?
  assert_equals "0" "$rc"
  assert_equals "" "$out"
}

# S32 sha.def 命令路径缺失或以 - 开头
test_S32_def_bad_cmd() {
  local out rc=0
  out=$(sha.def --desc x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "需要命令路径" "$out"
}

# S33 sha.def --help：打印自身 help，返回 0
test_S33_def_help() {
  local out rc=0
  out=$(sha.def --help 2>&1) || rc=$?
  assert_equals "0" "$rc"
  assert_contains "usage: " "$out"
  assert_contains " sha def " "$out"
  assert_contains "--opt" "$out"
  assert_contains "--arg" "$out"
  # --usage / --detail 已合并进 --desc
  case $out in *"--usage"*) return 1 ;; esac
  case $out in *"--detail"*) return 1 ;; esac
}

# S34 sha.def 不接受位置参数（-- 之后的也不行）
test_S34_def_no_positional() {
  local out rc=0
  out=$(sha.def "svc" -- --opt "--port:int=1:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "不接受位置参数" "$out"
}

# S35 注册三种分隔符写法等价（归一化到空格；查找侧函数名同样归一化）
test_S35_separator_forms() {
  local out rc=0
  out=$(sha.option "net.web" "--host:string:h:主机" 2>&1 \
    && sha.option "net__web" "--port:int=80:端口" 2>&1 \
    && sha.option "net web" "--tls:bool:加密" 2>&1 \
    && printf '|order=%s|host=%s' "${_SHA_OPT_ORDER[net web]}" \
      "${_SHA_OPT_TYPE[net web|host]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "order=host port tls" "$out"
  assert_contains "host=string" "$out"
}

# S36 非法路径归一化后同样拦截（"a__" → "a " 尾空格）
test_S36_bad_path_after_norm() {
  local out rc=0
  out=$(sha.option "a__" "--x:string:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "命令路径非法" "$out"
  rc=0
  out=$(sha.def "b..c" --desc x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "命令路径非法" "$out"
}

# S37 --arg 基本存储
test_S37_arg_basic() {
  local out rc=0
  out=$(sha.def "svc" --arg "FILE:输入文件" --arg "LIMIT:数量上限" 2>&1 \
    && printf '|args=%s|h=%s' "${_SHA_OPT_ARGS[svc]}" "${_SHA_OPT_ARG_HELP[svc|FILE]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "args=FILE LIMIT" "$out"
  assert_contains "h=输入文件" "$out"
}

# S38 必填 / variadic / 必填 variadic
test_S38_arg_flags() {
  local out rc=0
  out=$(sha.def "svc" --arg "SRC!:源文件" --arg "FILES...:文件列表" 2>&1 \
    && printf '|req=%s|rest=%s' "${_SHA_OPT_ARG_REQ[svc|SRC]}" "${_SHA_OPT_ARG_REST[svc|FILES]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "req=1" "$out"
  assert_contains "rest=1" "$out"
  rc=0
  out=$(sha.def "svc2" --arg "FILES!...:至少一个" 2>&1 \
    && printf '|req=%s|rest=%s' "${_SHA_OPT_ARG_REQ[svc2|FILES]}" "${_SHA_OPT_ARG_REST[svc2|FILES]}") || rc=$?
  assert_equals "0" "$rc"
  assert_contains "req=1" "$out"
  assert_contains "rest=1" "$out"
}

# S39 非法位置参数定义
test_S39_arg_errors() {
  local out rc=0
  out=$(sha.def "svc" --arg "FILE:a" --arg "FILE:b" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "重复" "$out"
  rc=0
  out=$(sha.def "svc" --arg "A...:a" --arg "B:b" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "最后一个" "$out"
  rc=0
  out=$(sha.def "svc" --arg "A:a" --arg "B!:b" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "选填" "$out"
  rc=0
  out=$(sha.def "svc" --arg "1X:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "名字" "$out"
  rc=0
  out=$(sha.def "*" --arg "FILE:x" 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "全局" "$out"
}

# S40 list/help 对应关系：list 选项 help 行以 NAME... 结尾（与位置参数 ... 同一套词汇）；
# int 只做词法校验："08" 注册通过（八进制陷阱是 bash 算术的事，int 不管）
test_S40_list_help_and_int_lexical() {
  local out rc=0
  out=$(sha.def "svc" --opt "--src:list:源码" --opt "--jobs:int=08:并行数" 2>&1 \
    && printf '|def=%s\n' "${_SHA_OPT_DEFAULT[svc|jobs]}" \
    && _sha_opt_print_help "svc" 2>&1) || rc=$?
  assert_equals "0" "$rc"
  assert_contains "def=08" "$out"
  assert_contains "--src SRC..." "$out"
}

sha_run() { "$@" 2>&1; }

# ---- 运行时用例 (解析 + 分发 + help)：demo 命令顶层注册 ----
# sha desc/usage/detail 也是顶层元数据，help 只读表、不进函数体。
sha.option "demo" \
  "-t,--target:string=macos:目标平台" \
  "--mode:string![fast|safe]:运行模式" \
  "--token:string:鉴权" \
  "--release:bool:优化构建" \
  "--jobs:int=4:并行数" \
  "--src:list:源码目录" \
  "--dry-run:bool:试运行"
sha.desc "demo" $'演示命令\n备注：mode 必填，其余选填。'
sha.option "*" "--verbose:bool:详细输出"

# T01 空格取值
test_T01_space_value() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s mode=%s jobs=%s release=%s files=%s' "$target" "$mode" "$jobs" "$release" "${files[*]}"
    }
    sha "$@"
  }
  assert_equals "target=linux mode=fast jobs=4 release=0 files=" "$(sha_run fixture demo --target linux --mode fast)"
}

# T02 等号取值 / T03 值含等号只按第一个切
test_T02_eq_value() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s mode=%s' "$target" "$mode"
    }
    sha "$@"
  }
  assert_equals "target=linux mode=fast" "$(sha_run fixture demo --target=linux --mode=fast)"
  assert_equals "target=a=b mode=fast" "$(sha_run fixture demo --target=a=b --mode fast)"
}

# T04 bool 裸出现 / --no- / 重复后胜
test_T04_bool() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'release=%s' "$release"
    }
    sha "$@"
  }
  assert_equals "release=1" "$(sha_run fixture demo --mode fast --release)"
  assert_equals "release=0" "$(sha_run fixture demo --mode fast --no-release)"
  assert_equals "release=0" "$(sha_run fixture demo --mode fast --release --no-release)"
}

# T05 bool 单词值 / 非法值
test_T05_bool_words() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'release=%s' "$release"
    }
    sha "$@"
  }
  assert_equals "release=0" "$(sha_run fixture demo --mode fast --release=false)"
  assert_equals "release=1" "$(sha_run fixture demo --mode fast --release=yes)"
  local out rc=0
  out=$(sha_run fixture demo --mode fast --release=maybe 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
}

# T06 --no- 只用于 bool
test_T06_no_prefix_nonbool() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode fast --no-target x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "bool" "$out"
}

# T07 值像选项也照吃（用 = 形式更稳）
test_T07_dash_value() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s' "$target"
    }
    sha "$@"
  }
  assert_equals "target=-foo" "$(sha_run fixture demo --target -foo --mode fast)"
}

# T08 行尾缺值
test_T08_missing_value() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode fast --jobs 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "requires a value" "$out"
}

# T09 未知长选项：报错并列出合法项
test_T09_unknown() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --bogus --mode fast 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unknown option [--bogus]" "$out"
  assert_contains "--target" "$out"
}

# T10 未知短选项
test_T10_unknown_short() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo -x --mode fast 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unknown option" "$out"
}

# T11 单独 - 是位置参数；T12 -- 截断；T13 混写保序
test_T11_12_13_positional() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'release=%s files=%s' "$release" "${files[*]}"
    }
    sha "$@"
  }
  assert_equals "release=0 files=- ./a" "$(sha_run fixture demo --mode fast - ./a)"
  assert_equals "release=0 files=--release" "$(sha_run fixture demo --mode fast -- --release)"
  assert_equals "release=0 files=./a ./b" "$(sha_run fixture demo ./a --mode fast ./b)"
}

# T14 scalar 重复后胜；list 追加
test_T14_repeat() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'jobs=%s src=%s' "$jobs" "${src[*]}"
    }
    sha "$@"
  }
  assert_equals "jobs=8 src=a b" "$(sha_run fixture demo --mode fast --jobs 2 --jobs 8 --src a --src=b)"
}

# T15 必填缺席 / 显式空都报错
test_T15_required() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "required" "$out"
  rc=0
  out=$(sha_run fixture demo --mode= 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "required" "$out"
}

# T16 选填缺席：无默认给空串，有默认给默认值
test_T16_optional_absent() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s token=%s' "$target" "$token"
    }
    sha "$@"
  }
  assert_equals "target=macos token=" "$(sha_run fixture demo --mode fast)"
}

# T17 enum 非法 / 大小写敏感
test_T17_enum() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode turbo 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "one of" "$out"
  rc=0
  out=$(sha_run fixture demo --mode FAST 2>&1) || rc=$?
  assert_equals "1" "$rc"
}

# T18 int 非法
test_T18_int() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode fast --jobs x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "integer" "$out"
}

# T19 短名空格 / 等号取值
test_T19_short() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s' "$target"
    }
    sha "$@"
  }
  assert_equals "target=linux" "$(sha_run fixture demo -t linux --mode fast)"
  assert_equals "target=linux" "$(sha_run fixture demo -t=linux --mode fast)"
}

# T20 -h 放选项后面也生效，且不进函数
test_T20_help_after_opts() {
  fixture() {
    demo() {
      echo "RAN"
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode fast -h 2>&1) || rc=$?
  assert_equals "0" "$rc"
  assert_contains "options:" "$out"
  assert_contains "default: macos" "$out"
  assert_contains "required" "$out"
  [[ $out != *RAN* ]]
}

# T21 demo -h：usage 第一行（由 options/args 自动生成）+ desc/detail + 全局段
test_T21_full_help() {
  fixture() {
    demo() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture demo -h 2>&1)
  # 块首行就是 usage（前面只有排版用的一行空白）
  assert_equals "usage: test_sha_opt.bash demo [-t TARGET] --mode MODE [--token TOKEN] [--release] [--jobs JOBS] [--src SRC...] [--dry-run]" "$(awk 'NF{print; exit}' <<<"$out")"
  assert_contains "演示命令" "$out"
  assert_contains "备注：mode 必填" "$out"
  assert_contains "global options:" "$out"
  assert_contains "--verbose" "$out"
}

# T22 -- 后的 --help 是位置参数
test_T22_help_after_ddash() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'files=%s' "${files[*]}"
    }
    sha "$@"
  }
  assert_equals "files=--help" "$(sha_run fixture demo --mode fast -- --help)"
}

# T23 全局选项 opt-in：不声明也能跑（传了才要求声明）；声明了才回填
test_T23_global_optin() {
  fixture_no() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'rc-ok'
    }
    sha "$@"
  }
  fixture_yes() {
    demo() {
      local target mode token release jobs verbose
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'verbose=%s' "$verbose"
    }
    sha "$@"
  }
  fixture_undeclared_use() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  assert_equals "rc-ok" "$(sha_run fixture_no demo --mode fast)"
  assert_equals "verbose=1" "$(sha_run fixture_yes demo --mode fast --verbose)"
  out=$(sha_run fixture_undeclared_use demo --mode fast --verbose 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "local verbose" "$out"
}

# T24 命令变量未声明 local：报错防写穿全局
test_T24_undeclared() {
  fixture() {
    demo() {
      local mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture demo --mode fast --target x 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "local target" "$out"
}

# T25 负数是合法 int，且照吃
test_T25_negative_int() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'jobs=%s' "$jobs"
    }
    sha "$@"
  }
  assert_equals "jobs=-1" "$(sha_run fixture demo --mode fast --jobs -1)"
}

# T26 显式空串与缺席可区分
test_T26_explicit_empty() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'target=%s' "$target"
    }
    sha "$@"
  }
  assert_equals "target=" "$(sha_run fixture demo --mode fast --target=)"
}

# T27 根 help 树带 desc
test_T27_tree_desc() {
  fixture() {
    demo() { :; }
    sha "$@"
  }
  assert_contains "演示命令" "$(sha_run fixture --help)"
}

# T28 bool 不吃下一个参数
test_T28_bool_no_consume() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
      printf 'release=%s files=%s' "$release" "${files[*]}"
    }
    sha "$@"
  }
  assert_equals "release=1 files=extra" "$(sha_run fixture demo --mode fast --release extra)"
}

# T29 直接调函数遇 -h：打印 help 返回 2（经 sha 入口时预扫已处理，只剩直接调用走这里）
test_T29_direct_help_code() {
  fixture() {
    demo() {
      local target mode token release jobs
      local -a src=() files=()
      sha_opt_parse files "$@" || return $?
    }
    demo -h >/dev/null 2>&1
  }
  local out rc=0
  out=$(sha_run fixture 2>&1) || rc=$?
  assert_equals "2" "$rc"
}

# T30 pos 数组名与选项变量重名：报错而不是静默丢数据
test_T30_pos_array_collision() {
  fixture() {
    sha.option "posdemo" "--files:string:文件" || return $?
    posdemo() {
      local files
      sha_opt_parse files a b || return $?
    }
    sha "$@"
  }
  local out rc=0
  out=$(sha_run fixture posdemo 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "重名" "$out"
}

# T31 点分隔注册 + 点分隔函数，空格分发照样命中（用户用什么分隔符写都行）
test_T31_dot_form_end_to_end() {
  fixture() {
    sha.def "net.web" --opt "--host:string:h:主机" --desc "网络" || return $?
    net.web() {
      local host
      local -a files=()
      sha_opt_parse files "$@" || return $?
      printf 'host=%s files=%s' "$host" "${files[*]}"
    }
    sha "$@"
  }
  assert_equals "host=example.com files=a" "$(sha_run fixture net web --host example.com a)"
}

# T32 位置参数运行时校验：缺必填 / 多余 / variadic 收集 / 选填缺席
test_T32_positional_validation() {
  fixture() {
    sha.def "cp2" --arg "SRC!:源文件" --arg "DST:目标" || return $?
    sha.def "mcat" --arg "FILES...:文件列表" || return $?
    sha.def "mreq" --arg "FILES!...:至少一个文件" || return $?
    cp2() {
      local -a files=()
      sha_opt_parse files "$@" || return $?
      printf 'files=%s' "${files[*]}"
    }
    mcat() {
      local -a files=()
      sha_opt_parse files "$@" || return $?
      printf 'files=%s' "${files[*]}"
    }
    mreq() {
      local -a files=()
      sha_opt_parse files "$@" || return $?
      printf 'files=%s' "${files[*]}"
    }
    sha "$@"
  }
  local out rc=0
  assert_equals "files=a b" "$(sha_run fixture cp2 a b)"
  out=$(sha_run fixture cp2 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "missing argument <SRC>" "$out"
  rc=0
  out=$(sha_run fixture cp2 a b c 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "unexpected argument [c]" "$out"
  assert_equals "files=a b c" "$(sha_run fixture mcat a b c)"
  assert_equals "files=" "$(sha_run fixture mcat)"
  rc=0
  out=$(sha_run fixture mreq 2>&1) || rc=$?
  assert_equals "1" "$rc"
  assert_contains "missing argument" "$out"
}

# T33 help 渲染 arguments 段 + usage 自动带上位置参数形态
test_T33_args_help_and_auto_usage() {
  fixture() {
    sha.def "up" \
      --desc "上传" \
      --opt "--host:string=h:主机" \
      --arg "FILE!:文件" \
      --arg "TAG:标签" || return $?
    sha.def "up2" \
      --arg "FILE!:文件" || return $?
    up() { :; }
    up2() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture up -h 2>&1)
  assert_contains "usage:" "$out"
  assert_contains "[--host HOST]" "$out"
  assert_contains "<FILE>" "$out"
  assert_contains "[TAG]" "$out"
  assert_contains "arguments:" "$out"
  assert_contains "FILE" "$out"
  assert_contains "(required)" "$out"
  out=$(sha_run fixture up2 -h 2>&1)
  assert_contains "up2" "$out"
  assert_contains "<FILE>" "$out"
  [[ $out != *"[options]"* ]]
}

# S41 函数注释优先于 sha.desc：注释 desc / 用法 / detail 全胜出
test_S41_doc_comment_beats_meta() {
  fixture() {
    sha.desc "svc" $'显式 desc 应被覆盖\n显式 detail 应被覆盖'
    #: 注释 desc 胜出
    #: 用法: sha svc <NAME>
    #: 注释 detail
    svc() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture svc --help 2>&1)
  assert_contains "注释 desc 胜出" "$out"
  assert_contains "usage: sha svc <NAME>" "$out"
  assert_contains "注释 detail" "$out"
  case $out in *"显式 desc 应被覆盖"*) return 1 ;; esac
  case $out in *"sha svc OLD"*) return 1 ;; esac
  return 0
}

# S42 只有函数注释、没有任何 option/desc 注册：--help 也出完整 help（不再是空子命令列表）
test_S42_doc_only_help() {
  fixture() {
    #: 纯注释命令
    #: 用法: sha nospec [X]
    nospec() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture nospec --help 2>&1)
  assert_contains "usage: " "$out"
  assert_contains " nospec" "$out"
  assert_contains "纯注释命令" "$out"
  assert_contains "usage: sha nospec [X]" "$out"
  # 无注册时也不能把注释当成「没有 help」而回落到子命令列表
  case $out in *"Available Commands"*) return 1 ;; esac
  return 0
}

# S43 带注释的父命令：-h 走完整 help，且一并列出下一层（不透掉子命令）
test_S43_doc_help_lists_children() {
  fixture() {
    #: 父命令
    #: 用法: sha p [--x N]
    p() { :; }
    #: 子命令 s
    p.s() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture p -h 2>&1)
  assert_contains "usage: sha p [--x N]" "$out"
  assert_contains "  s  子命令 s" "$out"
  # 叶子命令不喷空列表
  out=$(sha_run fixture p s -h 2>&1)
  assert_contains "子命令 s" "$out"
  case $out in *commands:*) return 1 ;; esac
  return 0
}

# S44 option 层也认 -h 叠写：-hh 展开全树；-- 之后的 -hh 是位置参数
test_S44_pre_scan_hh_tree() {
  fixture() {
    #: 父 p
    #: 用法: sha p
    p() { :; }
    #: 子 p.q
    p.q() { :; }
    #: 孙 p.q.r
    p.q.r() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture p -h 2>&1)
  assert_contains "  q  子 p.q" "$out"
  case $out in *"  r"*) return 1 ;; esac
  out=$(sha_run fixture p -hh 2>&1)
  assert_contains "  q  子 p.q" "$out"
  assert_contains "    r  孙 p.q.r" "$out"
  # -h 与 -hh 共存取更详细的那一档
  out=$(sha_run fixture p -h -hh 2>&1)
  assert_contains "    r  孙 p.q.r" "$out"
  # -- 之后不当选项
  out=$(sha_run fixture p -- -hh 2>&1)
  case $out in *commands:*) return 1 ;; esac
  return 0
}

# S45 sha.parse：声明什么解析什么——选项写同名 local，位置参数写 --arg 声明的名字
test_S45_sha_parse_by_name() {
  fixture() {
    sha.def "pb" \
      --desc "解析演示" \
      --opt "-t,--target:string=macos:目标" \
      --opt "--mode:string![fast|safe]:模式" \
      --arg "FILE!:文件" \
      --arg "TAG:标签" || return $?
    pb() {
      local target mode
      local FILE="" TAG=""
      sha.parse "$@" || return $?
      printf 'target=%s mode=%s FILE=%s TAG=%s' "$target" "$mode" "$FILE" "$TAG"
    }
    sha "$@"
  }
  local out
  out=$(sha_run fixture pb --mode fast -t linux ./a ./b 2>&1)
  assert_equals "target=linux mode=fast FILE=./a TAG=./b" "$out"
  # 必填 --mode 缺失 -> 报错
  out=$(sha_run fixture pb ./a 2>&1) || true
  assert_contains "mode" "$out"
  # 只给必填 + 第一个位置参数：默认值生效、TAG 留空
  out=$(sha_run fixture pb --mode safe ./a 2>&1)
  assert_equals "target=macos mode=safe FILE=./a TAG=" "$out"
  # 多传位置参数 -> 报错
  out=$(sha_run fixture pb --mode fast a b c 2>&1) || true
  assert_contains "unexpected argument" "$out"
  return 0
}

# S46 没声明 --arg 的命令收到位置参数：当参数用错，报错并给 usage（不再有默认 args 兜底）
test_S46_no_arg_declared_rejects_positional() {
  fixture() {
    sha.def "np" --opt "--target:string=macos:目标" || return $?
    np() { local target; sha.parse "$@" || return $?; echo "target=$target"; }
    sha "$@"
  }
  local out status=0
  out=$(sha_run fixture np xyz 2>&1) || status=$?
  assert_equals "1" "$status"
  assert_contains "不接受位置参数" "$out"
  assert_contains "usage:" "$out"
  # 纯选项仍然通
  out=$(sha_run fixture np --target linux 2>&1)
  assert_equals "target=linux" "$out"
  return 0
}

# S46b --arg 声明了名字却没 local 同名变量：报错并提示补 local（防"解析不出来还以为成功"）
test_S46b_missing_local_var() {
  fixture() {
    sha.def "mv" --arg "FILE!:文件" || return $?
    mv() { sha.parse "$@" || return $?; echo "no-local"; }
    sha "$@"
  }
  local out status=0
  out=$(sha_run fixture mv ./a 2>&1) || status=$?
  assert_equals "1" "$status"
  assert_contains "必须先声明 local FILE" "$out"
  assert_contains "usage:" "$out"
  return 0
}

# S46c sha.parse -h 只说自己的用法
test_S46c_sha_parse_own_help() {
  local out
  out=$(sha.parse -h 2>&1)
  assert_contains "usage: sha.parse" "$out"
  assert_contains "FILES..." "$out"
}

# S47 位置参数按 --arg 声明的名字写回：标量 / 变长数组（声明成标量也会被提升为数组）
test_S47_args_writeback_by_name() {
  fixture() {
    sha.def "rp" \
      --opt "--mode:string=fast:模式" \
      --arg "FILE!:文件" \
      --arg "REST...:其余" || return $?
    rp() {
      local mode
      local FILE="" REST=""
      sha.parse "$@" || return $?
      printf 'mode=%s FILE=%s REST=%s' "$mode" "$FILE" "${REST[*]}"
    }
    sha "$@"
  }
  local out
  out=$(sha_run fixture rp a b c 2>&1)
  assert_equals "mode=fast FILE=a REST=b c" "$out"
  out=$(sha_run fixture rp a 2>&1)
  assert_equals "mode=fast FILE=a REST=" "$out"
  # 未声明同名变量时不向全局写穿
  assert_equals "" "$(declare -p FILE 2>/dev/null)"
  # 单个标量 + 无变长：--arg 名字直接当变量用
  fixture2() {
    sha.def "rp2" --arg "ENV!:环境" --arg "TAG:标签" || return $?
    rp2() { local ENV="" TAG=""; sha.parse "$@" || return $?; printf 'ENV=%s TAG=%s' "$ENV" "$TAG"; }
    sha "$@"
  }
  out=$(sha_run fixture2 rp2 prod v1 2>&1)
  assert_equals "ENV=prod TAG=v1" "$out"
  out=$(sha_run fixture2 rp2 prod 2>&1)
  assert_equals "ENV=prod TAG=" "$out"
  return 0
}

run_tests

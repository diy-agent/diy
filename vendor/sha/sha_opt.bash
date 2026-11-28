#!/usr/bin/env bash
#
# sha_opt.bash: option 定义 (sha.option)。解析 (sha_opt_parse) 后续实现。
#
# 规范 (PEG, 唯一正解, 与 test_sha_opt.bash 头部完全一致):
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
#
# PEG 之外的语义约束 (编号对应 test_sha_opt.bash):
#   长选项必须带 -- 前缀, 短选项必须配长选项 (S15); bool 不接受 =/!/枚举 (S16);
#   必填(!)不能同时有默认值 (S17); --help/-h 保留 (S20); 同表长名/短名不重复,
#   映射后变量撞车报错 (S19/S21); 默认值注册时校验 (类型/枚举归属, S23);
#   list 不接受默认值, 全局(*)只接受选填 (S24)。
#
# 存储 (供 sha_opt_parse 与 help 渲染消费, 测试可直接断言):
#   _SHA_OPT_TYPE["cmd|var"], _SHA_OPT_DEFAULT["cmd|var"], _SHA_OPT_HAS_DEFAULT,
#   _SHA_OPT_REQUIRED, _SHA_OPT_ENUM (原始 a|b), _SHA_OPT_HELP, _SHA_OPT_LONG,
#   _SHA_OPT_SHORT["cmd|short"] -> var, _SHA_OPT_ORDER["cmd"] -> "var var ..."

# 版本闸门: 本文件大量用 nameref (declare -n / unset -n, Bash 4.3+) 与关联数组;
# 低于 4.3 直接拒绝加载，而不是到用的时候报 "invalid option"。
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  printf 'sha_opt: 需要 Bash 4.3+ (用到 nameref / declare -n), 当前 %s\n' "$BASH_VERSION" >&2
  return 1 2>/dev/null || exit 1
fi

declare -A _SHA_OPT_TYPE=()
declare -A _SHA_OPT_LONG=()
declare -A _SHA_OPT_DEFAULT=()
declare -A _SHA_OPT_HAS_DEFAULT=()
declare -A _SHA_OPT_REQUIRED=()
declare -A _SHA_OPT_ENUM=()
declare -A _SHA_OPT_HELP=()
declare -A _SHA_OPT_SHORT=()   # "cmd|short" -> var
declare -A _SHA_OPT_SHORT_OF=() # "cmd|var" -> short (无则空)
declare -A _SHA_OPT_ORDER=()   # "cmd" -> "var var ..."
declare -A _SHA_OPT_ARGS=()      # "cmd" -> "NAME NAME ..." (位置参数，声明顺序)
declare -A _SHA_OPT_ARG_HELP=()  # "cmd|NAME" -> help
declare -A _SHA_OPT_ARG_REQ=()   # "cmd|NAME" -> 1 (必填)
declare -A _SHA_OPT_ARG_REST=()  # "cmd|NAME" -> 1 (variadic ...，吞掉剩余全部)

_sha_opt_error() { echo "ERROR: $*" >&2; return 1; }

# 命令路径规范化：与 sha.bash 自注册同一套映射（. 与 __ → 空格，单个 _ 不动）。
# 注册 (sha.option/sha.def/sha.desc/...) 与查找 (sha_opt_parse) 都走这里，所以
# "build web" / "build.web" / "build__web" 三种写法等价——调用者用什么分隔符都行。
# $1=原始路径, $2=输出变量名；归一化 + 严格校验，失败返回 1
_sha_opt_norm_cmd() {
  local p=$1
  p=${p//__/ }
  p=${p//./ }
  printf -v "$2" '%s' "$p"
}

_sha_opt_check_cmd() {
  local raw=$1 outvar=$2 norm=""
  _sha_opt_norm_cmd "$raw" norm
  if [[ -z $norm || $norm == ' '* || $norm == *' ' || $norm == *'  '* ]]; then
    _sha_opt_error "命令路径非法 [$raw]"
    return 1
  fi
  printf -v "$outvar" '%s' "$norm"
}

# 用法: sha.option "<cmd>" "<spec>..."
#   cmd: 命令路径 ("build web" / "build.web" / "build__web" 等价) 或 "*" (全局选项)
sha.option() {
  local raw=$1; shift
  local cmd=""
  _sha_opt_check_cmd "$raw" cmd || return $?
  local spec
  for spec in "$@"; do
    _sha_opt_add "$cmd" "$spec" || return $?
  done
}

_sha_opt_add() {
  local cmd=$1 spec=$2
  local head rest

  # opt-head ":" ... : head 永不含冒号, 按第一个冒号切
  case $spec in
    *:*)
      head=${spec%%:*}
      rest=${spec#*:}
      ;;
    *)
      _sha_opt_error "非法 option 定义 [$spec]，缺少 : 分隔"
      return $?
      ;;
  esac

  # --- opt-head: (short ",")? longopt ---
  local short="" long=""
  case $head in
    -*,--*)
      short=${head%%,*}
      long=${head#*,}
      ;;
    --*)
      long=$head
      ;;
    -*)
      _sha_opt_error "非法 option 定义 [$spec]，短选项必须与长选项连用，如 -t,--target"
      return $?
      ;;
    *)
      _sha_opt_error "非法 option 定义 [$spec]，长选项必须以 -- 开头"
      return $?
      ;;
  esac
  local re_short='^-[A-Za-z0-9]$' re_long='^--[A-Za-z][A-Za-z0-9_-]*$'
  if [[ -n $short && ! $short =~ $re_short ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，短选项名非法 [$short]，必须是 - 加单个字母数字"
    return $?
  fi
  if [[ ! $long =~ $re_long ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，长选项名非法 [$long]"
    return $?
  fi
  if [[ $long == "--help" || $short == "-h" ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，--help / -h 保留给 help 通道"
    return $?
  fi
  local var=${long#--}
  var=${var//-/_}

  # --- type ---
  local type tail
  local re_type='^(string|int|bool|list)(.*)$'
  if [[ $rest =~ $re_type ]]; then
    type=${BASH_REMATCH[1]}
    tail=${BASH_REMATCH[2]}
  else
    _sha_opt_error "非法 option 定义 [$spec]，缺少类型，只支持 string/int/bool/list"
    return $?
  fi

  # --- ("=" default)? : default 取到第一个 ! [ : 之前 ---
  local default="" has_default=0
  if [[ $tail == =* ]]; then
    local t=${tail#=} a b c
    a=${t%%!*}
    b=${t%%\[*}
    c=${t%%:*}
    default=$a
    [[ ${#b} -lt ${#default} ]] && default=$b
    [[ ${#c} -lt ${#default} ]] && default=$c
    if [[ -z $default ]]; then
      _sha_opt_error "非法 option 定义 [$spec]，默认值不能为空（无默认值就别写 =）"
      return $?
    fi
    has_default=1
    tail=${t:${#default}}
  fi

  # --- ("!")? ---
  local req=0
  if [[ $tail == '!'* ]]; then
    req=1
    tail=${tail#'!'}
  fi

  # --- enum-block? ---
  local enum=""
  if [[ $tail == "["* ]]; then
    local after=${tail:1}
    case $after in
      *]*)
        enum=${after%%]*}
        tail=${after#*]}
        ;;
      *)
        _sha_opt_error "非法 option 定义 [$spec]，枚举缺少 ]"
        return $?
        ;;
    esac
    if [[ -z $enum ]]; then
      _sha_opt_error "非法 option 定义 [$spec]，枚举不能为空"
      return $?
    fi
    local lit
    IFS='|' read -ra _sha_opt_lits <<<"$enum"
    for lit in ${_sha_opt_lits[@]+"${_sha_opt_lits[@]}"}; do
      case $lit in
        ""|*:*)
          _sha_opt_error "非法 option 定义 [$spec]，枚举字面量非法 [$lit]"
          return $?
          ;;
      esac
    done
  fi

  # --- (":" help)? ---
  local help=""
  if [[ -n $tail ]]; then
    case $tail in
      :*)
        help=${tail#:}
        ;;
      *)
        _sha_opt_error "非法 option 定义 [$spec]，无法解析的尾部 [$tail]"
        return $?
        ;;
    esac
  fi

  # --- 语义约束 ---
  if [[ $type == "bool" ]]; then
    if (( has_default || req )) || [[ -n $enum ]]; then
      _sha_opt_error "非法 option 定义 [$spec]，bool 不接受默认值 / required / 枚举"
      return $?
    fi
  fi
  if (( req && has_default )); then
    _sha_opt_error "非法 option 定义 [$spec]，required 不能同时有默认值"
    return $?
  fi
  if [[ $type == "list" && $has_default == "1" ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，list 不支持默认值（缺席即空数组）"
    return $?
  fi
  if [[ $cmd == "*" && $req == "1" ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，全局选项只接受选填"
    return $?
  fi
  # NOTE: int 只做词法校验（"08" 能通过，见 S40），不管范围、不做归一化；
  # bash 算术的八进制陷阱（$((08)) 报错）不在 int 的保证范围内。
  local re_int='^[+-]?[0-9]+$'
  if (( has_default )) && [[ $type == "int" && ! $default =~ $re_int ]]; then
    _sha_opt_error "非法 option 定义 [$spec]，默认值 [$default] 不是整数"
    return $?
  fi
  if (( has_default )) && [[ -n $enum ]]; then
    local found=0 l
    IFS='|' read -ra _sha_opt_lits <<<"$enum"
    for l in ${_sha_opt_lits[@]+"${_sha_opt_lits[@]}"}; do
      [[ $l == "$default" ]] && found=1
    done
    if (( ! found )); then
      _sha_opt_error "非法 option 定义 [$spec]，默认值 [$default] 不在枚举 [$enum] 内"
      return $?
    fi
  fi

  # --- 重复 / 撞车 ---
  local key="$cmd|$var"
  if [[ -n ${_SHA_OPT_TYPE[$key]+x} ]]; then
    if [[ ${_SHA_OPT_LONG[$key]} != "$long" ]]; then
      _sha_opt_error "非法 option 定义 [$spec]，[$long] 与 [${_SHA_OPT_LONG[$key]}] 映射到同一变量 [$var]"
      return $?
    fi
    _sha_opt_error "非法 option 定义 [$spec]，选项 [$long] 在 [$cmd] 重复定义"
    return $?
  fi
  if [[ -n $short ]]; then
    local sshort=${short#-}
    if [[ -n ${_SHA_OPT_SHORT[$cmd|$sshort]+x} ]]; then
      _sha_opt_error "非法 option 定义 [$spec]，短选项 [$short] 在 [$cmd] 重复"
      return $?
    fi
    local k v
    # NOTE: 不用 ${!arr[@]+"${!arr[@]}"} 守卫写法，它与 ${!arr[@]} 取键形式
    # 不兼容（会被当成间接展开，恒为空，冲突检测变死代码）；本项目禁 nounset，
    # 空关联数组直接引用的展开是安全的。
    for k in "${!_SHA_OPT_SHORT[@]}"; do
      if [[ $k == *"|$sshort" && $k != "$cmd|$sshort" ]]; then
        v=${_SHA_OPT_SHORT[$k]}
        if [[ $v != "$var" && ( $k == "*|$sshort" || $cmd == "*" ) ]]; then
          _sha_opt_error "非法 option 定义 [$spec]，短选项 [$short] 与 [$k] 冲突"
          return $?
        fi
      fi
    done
  fi

  # --- 落表 ---
  _SHA_OPT_TYPE[$key]=$type
  _SHA_OPT_LONG[$key]=$long
  _SHA_OPT_REQUIRED[$key]=$req
  _SHA_OPT_ENUM[$key]=$enum
  _SHA_OPT_HELP[$key]=$help
  if (( has_default )); then
    _SHA_OPT_DEFAULT[$key]=$default
    _SHA_OPT_HAS_DEFAULT[$key]=1
  fi
  [[ -n $short ]] && _SHA_OPT_SHORT[$cmd|${short#-}]=$var
  _SHA_OPT_SHORT_OF[$key]=${short#-}
  _SHA_OPT_ORDER[$cmd]="${_SHA_OPT_ORDER[$cmd]:+${_SHA_OPT_ORDER[$cmd]} }$var"
}

# 位置参数声明: NAME[!][...][:help]
#   FILE        选填；FILE! 必填；FILES... 选填 variadic（吞剩余全部，须最后）；
#   FILES!...  必填 variadic（至少 1 个，须最后）；必填不能跟在选填之后。
# 未声明 args 的命令保持透传兼容（位置参数不校验）。
_sha_opt_add_arg() {
  local cmd=$1 spec=$2
  local head help=""
  case $spec in
    *:* ) head=${spec%%:*}; help=${spec#*:} ;;
    * ) head=$spec ;;
  esac
  local name=$head req=0 vrest=0
  case $name in
    *... ) vrest=1; name=${name%...} ;;
  esac
  case $name in
    *! ) req=1; name=${name%!} ;;
  esac
  local re_name='^[A-Za-z_][A-Za-z0-9_]*$'
  if [[ -z $name || ! $name =~ $re_name ]]; then
    _sha_opt_error "非法位置参数定义 [$spec]，名字必须匹配 [A-Za-z_][A-Za-z0-9_]*"
    return $?
  fi
  if [[ $cmd == "*" ]]; then
    _sha_opt_error "非法位置参数定义 [$spec]，全局不接受位置参数"
    return $?
  fi
  if [[ -n ${_SHA_OPT_ARG_REQ[$cmd|$name]+x} ]]; then
    _sha_opt_error "非法位置参数定义 [$spec]，位置参数 [$name] 在 [$cmd] 重复定义"
    return $?
  fi
  if [[ -n ${_SHA_OPT_ARGS[$cmd]:-} ]]; then
    local prev=${_SHA_OPT_ARGS[$cmd]##* }
    if [[ ${_SHA_OPT_ARG_REST[$cmd|$prev]:-0} == "1" ]]; then
      _sha_opt_error "非法位置参数定义 [$spec]，variadic [$prev...] 必须是最后一个"
      return $?
    fi
    if (( req )) && [[ ${_SHA_OPT_ARG_REQ[$cmd|$prev]:-0} != "1" ]]; then
      _sha_opt_error "非法位置参数定义 [$spec]，必填 [$name] 不能跟在选填 [$prev] 之后"
      return $?
    fi
  fi
  _SHA_OPT_ARGS[$cmd]="${_SHA_OPT_ARGS[$cmd]:+${_SHA_OPT_ARGS[$cmd]} }$name"
  _SHA_OPT_ARG_HELP[$cmd|$name]=$help
  _SHA_OPT_ARG_REQ[$cmd|$name]=$req
  _SHA_OPT_ARG_REST[$cmd|$name]=$vrest
}

##################################################################################################
### desc 注册、help 渲染、参数解析
###
### 只有一份文案源: desc (可多行, 首行=一句话说明, 其余行=补充说明)。
### usage 不注册, 由 options/args 自动生成 (注释里的 "用法:" 行可覆盖)。
##################################################################################################

declare -A _SHA_DESC=()
declare -A _SHA_DETAIL=()   # desc 的其余行 (内部, 无单独注册入口)

# 一次调用定义完一个命令的全部元数据（desc/option/arg），实现体仍是
# 独立 bash 函数（按名映射发现，见 sha.bash）。底层委托给 sha.option/sha.desc，
# 任一步失败即返回非零。
#
# 自举：本函数的参数直接用 option 语法声明（见文件尾 "sha def" 注册），
# 解析走 sha_opt_parse，与用户命令同一套逻辑。
#
# 用法: sha.def "<cmd>" [--opt SPEC]... [--arg SPEC]... [--desc T]
#   参数顺序约定: --opt / --arg 在前, --desc 放最后一行 (多行文案不夹在中间)
sha.def() {
  if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
    _sha_opt_print_help "sha def"
    return 0
  fi
  local raw=$1; shift
  [[ -n ${raw:-} && $raw != -* ]] || { _sha_opt_error "sha.def 需要命令路径"; return $?; }
  local cmd=""
  _sha_opt_check_cmd "$raw" cmd || return $?
  local desc=""
  local -a opt=() rest=() arg=()
  sha_opt_parse rest "$@" || return $?
  if (( ${#rest[@]} )); then
    _sha_opt_error "sha.def [$cmd] 不接受位置参数 [${rest[*]}]"
    return $?
  fi
  [[ -n $desc ]] && { sha.desc "$cmd" "$desc" || return $?; }
  if (( ${#opt[@]} )); then
    sha.option "$cmd" "${opt[@]}" || return $?
  fi
  local a
  for a in ${arg[@]+"${arg[@]}"}; do
    _sha_opt_add_arg "$cmd" "$a" || return $?
  done
}

# 用法: sha.desc "<cmd>" "<文案>"
#   单行 = 一句话说明; 多行 = 首行说明 + 其余行补充说明 (与函数注释 "#:" 块同一规则)
sha.desc() {
  local raw=$1 text=${2:-} cmd=""
  [[ -n ${raw:-} ]] || { _sha_opt_error "sha.desc 需要命令路径"; return $?; }
  _sha_opt_norm_cmd "$raw" cmd
  case $text in
    *$'\n'*)
      _SHA_DESC[$cmd]=${text%%$'\n'*}
      _SHA_DETAIL[$cmd]=${text#*$'\n'}
      ;;
    *) _SHA_DESC[$cmd]=$text ;;
  esac
  return 0
}

# 是否有完整 help 可打 (spec / desc 任一，或全局选项存在，或写了函数注释)
_sha_opt_has_help() {
  local cmd=$1 fn
  [[ -n $cmd ]] || return 1
  [[ -n ${_SHA_OPT_ORDER[$cmd]:-} || -n ${_SHA_DESC[$cmd]:-} ]] && return 0
  [[ -n ${_SHA_DETAIL[$cmd]:-} ]] && return 0
  [[ -n ${_SHA_OPT_ORDER['*']:-} ]] && return 0
  # 什么都没注册、但函数上方写了 #: 注释也算有 help（只在见到 -h 时才走到这里）
  fn=${_SHA_FUNC[$cmd]:-}
  if [[ -n $fn ]] && declare -F _sha_doc_scan >/dev/null 2>&1; then
    _sha_doc_scan "$fn"
    [[ -n ${_SHA_DOC_DESC[$fn]:-} ]] && return 0
  fi
  return 1
}

# 取一个命令的 desc / detail / usage：函数注释优先，sha.desc 兜底
# 用法: _sha_opt_meta <cmd> <out_desc> <out_detail> <out_usage>  (out_* 为变量名)
_sha_opt_meta() {
  local cmd=$1 fn=${_SHA_FUNC[$1]:-}
  printf -v "$2" '%s' "${_SHA_DESC[$cmd]:-}"
  printf -v "$3" '%s' "${_SHA_DETAIL[$cmd]:-}"
  printf -v "$4" '%s' ''
  [[ -n $fn ]] || return 0
  declare -F _sha_doc_scan >/dev/null 2>&1 || return 0
  _sha_doc_scan "$fn"
  [[ -n ${_SHA_DOC_DESC[$fn]:-} ]] && printf -v "$2" '%s' "${_SHA_DOC_DESC[$fn]}"
  [[ -n ${_SHA_DOC_DETAIL[$fn]:-} ]] && printf -v "$3" '%s' "${_SHA_DOC_DETAIL[$fn]}"
  [[ -n ${_SHA_DOC_USAGE[$fn]:-} ]] && printf -v "$4" '%s' "${_SHA_DOC_USAGE[$fn]}"
  return 0
}

_sha_opt_one_line() {
  local key=$1 long=$2 var=$3
  local type=${_SHA_OPT_TYPE[$key]} req=${_SHA_OPT_REQUIRED[$key]}
  local enum=${_SHA_OPT_ENUM[$key]} help=${_SHA_OPT_HELP[$key]}
  local short=${_SHA_OPT_SHORT_OF[$key]:-}
  local head meta="" mv
  if [[ $type == "bool" ]]; then
    mv=""
  else
    mv=${var^^}
    [[ $type == "list" ]] && mv="$mv..."
  fi
  if [[ -n $short ]]; then
    head="-$short, $long"
  else
    head="$long"
  fi
  [[ -n $mv ]] && head="$head $mv"
  local parts=()
  (( req )) && parts+=("required")
  if [[ -n ${_SHA_OPT_HAS_DEFAULT[$key]:-} ]]; then
    parts+=("default: ${_SHA_OPT_DEFAULT[$key]}")
  fi
  [[ -n $enum ]] && parts+=("must be $enum")
  if (( ${#parts[@]} )); then
    local joined=${parts[0]} i
    for (( i=1; i<${#parts[@]}; i++ )); do joined="$joined, ${parts[i]}"; done
    meta=" ($joined)"
  fi
  printf '  %-26s %s%s\n' "$head" "$help" "$meta"
}

# usage 行：一行说完「程序 命令 选项 位置参数」，直接反映注册的 options / args
#   usage: sha build [-t T] --mode M [--release] [--jobs N] <FILE> [LIMIT]
#   选填 → [方括号]，必填(!) → 裸写，bool 不带值，list 带 VAR...
# 函数注释里写了 "用法:" 行就以它为准（$2）。
_sha_opt_print_usage() {
  local cmd=$1 doc_usage=${2:-}
  if [[ -n $doc_usage ]]; then
    echo "usage: $doc_usage"
    return 0
  fi
  local u="${0##*/}"
  [[ -n $cmd ]] && u+=" $cmd"
  local v key type req short head mv an akey
  # 局部选项（全局选项(*|…)不占 usage 行）
  for v in ${_SHA_OPT_ORDER[$cmd]:-}; do
    key="$cmd|$v"
    type=${_SHA_OPT_TYPE[$key]}
    req=${_SHA_OPT_REQUIRED[$key]:-0}
    short=${_SHA_OPT_SHORT_OF[$key]:-}
    head=${short:+"-$short"}
    [[ -n $head ]] || head=${_SHA_OPT_LONG[$key]}
    mv=""
    case $type in
      bool) ;;
      list) mv=" ${v^^}..." ;;
      *) mv=" ${v^^}" ;;
    esac
    if (( req )); then u+=" $head$mv"; else u+=" [$head$mv]"; fi
  done
  for an in ${_SHA_OPT_ARGS[$cmd]:-}; do
    akey="$cmd|$an"
    if [[ ${_SHA_OPT_ARG_REST[$akey]:-0} == "1" ]]; then
      if [[ ${_SHA_OPT_ARG_REQ[$akey]:-0} == "1" ]]; then u+=" <$an...>"; else u+=" [$an...]"; fi
    elif [[ ${_SHA_OPT_ARG_REQ[$akey]:-0} == "1" ]]; then u+=" <$an>"
    else u+=" [$an]"
    fi
  done
  echo "usage: $u"
  return 0
}

# 完整 help 版式（段与段之间空一行）：
#   usage: <prog> <cmd> [opts] [args]
#
#   <desc 首行>
#   <desc 其余行>
#
#   options:
#   arguments:
#   global options:
#   commands:
_sha_opt_print_help() { # $1=cmd $2=层级 (1=只本层, 0=整棵树)
  local cmd=$1 depth=${2:-1} v key an akey ameta desc detail usage
  _sha_opt_meta "$cmd" desc detail usage
  echo
  _sha_opt_print_usage "$cmd" "$usage"
  if [[ -n $desc ]]; then
    echo
    echo "$desc"
    [[ -n $detail ]] && echo "$detail"
  elif [[ -n $detail ]]; then
    echo
    echo "$detail"
  fi
  if [[ -n ${_SHA_OPT_ORDER[$cmd]:-} ]]; then
    echo
    echo "options:"
    for v in ${_SHA_OPT_ORDER[$cmd]}; do
      key="$cmd|$v"
      _sha_opt_one_line "$key" "${_SHA_OPT_LONG[$key]}" "$v"
    done
  fi
  if [[ -n ${_SHA_OPT_ARGS[$cmd]:-} ]]; then
    echo
    echo "arguments:"
    for an in ${_SHA_OPT_ARGS[$cmd]}; do
      akey="$cmd|$an"
      ameta=""
      [[ ${_SHA_OPT_ARG_REQ[$akey]:-0} == "1" ]] && ameta=" (required)"
      [[ ${_SHA_OPT_ARG_REST[$akey]:-0} == "1" ]] && an="$an..."
      printf '  %-26s %s%s\n' "$an" "${_SHA_OPT_ARG_HELP[$akey]}" "$ameta"
    done
  fi
  if [[ -n ${_SHA_OPT_ORDER['*']:-} ]]; then
    echo
    echo "global options:"
    for v in ${_SHA_OPT_ORDER['*']}; do
      key="*|$v"
      _sha_opt_one_line "$key" "${_SHA_OPT_LONG[$key]}" "$v"
    done
  fi
  # 有子命令就一并列出: 完整 help = 自己那一层 + 下一层 (与分发层 help 共用渲染)
  if declare -F _sha_help_list >/dev/null 2>&1; then _sha_help_list "$cmd" "$depth"; fi
  echo
}

# 分发层预扫: 余下参数在 -- 之前出现 -h/--help 即打完整 help
#   -h = 本层, -hh/-hhh… = 整棵树 (叠写计数, 多处出现取最深的一处)
# 返回 0=已打印(caller 直接 return 0), 1=未处理(继续)
# 先扫参数再查 has_help: 无 -h 时零开销 (has_help 可能要为注释读一次源文件)
_sha_opt_pre_scan() {
  local cmd=$1; shift
  local a want=0 d
  for a in ${@+"$@"}; do
    case $a in
      --) break ;;
    esac
    if _sha_help_depth "$a" d; then
      want=1
      [[ $d == 1 ]] || want=$d   # 0 (全树) 比 1 更详细
    fi
  done
  (( want )) || return 1
  _sha_opt_has_help "$cmd" || return 1
  _sha_opt_print_help "$cmd" "$want"; return 0
}

# 按长名找选项，打印 "cmd|var" 或 "*|var"，找不到返回 1
_sha_opt_find_long() {
  local cmd=$1 name=$2 v
  for v in ${_SHA_OPT_ORDER[$cmd]:-}; do
    [[ ${_SHA_OPT_LONG[$cmd|$v]} == "--$name" ]] && { printf '%s' "$cmd|$v"; return 0; }
  done
  for v in ${_SHA_OPT_ORDER['*']:-}; do
    [[ ${_SHA_OPT_LONG[*|$v]} == "--$name" ]] && { printf '%s' "*|$v"; return 0; }
  done
  return 1
}

# 按短名找，打印 key
_sha_opt_find_short() {
  local cmd=$1 short=$2
  [[ -n ${_SHA_OPT_SHORT[$cmd|$short]:-} ]] && { printf '%s' "$cmd|${_SHA_OPT_SHORT[$cmd|$short]}"; return 0; }
  [[ -n ${_SHA_OPT_SHORT[*|$short]:-} ]] && { printf '%s' "*|${_SHA_OPT_SHORT[*|$short]}"; return 0; }
  return 1
}

_sha_opt_valid_list() {
  local cmd=$1 v s out=""
  for v in ${_SHA_OPT_ORDER[$cmd]:-}; do
    s=${_SHA_OPT_SHORT_OF[$cmd|$v]:-}
    out="$out ${_SHA_OPT_LONG[$cmd|$v]}${s:+/-$s}"
  done
  for v in ${_SHA_OPT_ORDER['*']:-}; do
    s=${_SHA_OPT_SHORT_OF[*|$v]:-}
    out="$out ${_SHA_OPT_LONG[*|$v]}${s:+/-$s}"
  done
  printf '%s' "${out# }"
}

# 用法: sha_opt_parse [--cmd CMD] <pos_array> "$@"
#   pos_array: 调用方预先 local -a 的数组名，位置参数按原相对顺序写入
#   命令路径缺省从调用函数名推导 (build.web() -> "build web")；
#   中间隔了一层包装函数时用 --cmd 显式指定（sha.parse 就是这么用的）
# 返回: 0 解析成功 / 1 报错(已打印) / 2 遇到 -h/--help(已打印 help)
sha_opt_parse() {
  local pos_array=$1 cmd_override="" caller
  shift
  if [[ $pos_array == "--cmd" ]]; then
    (( $# >= 2 )) || {
      _sha_opt_error "用法: sha_opt_parse --cmd CMD <pos_array> \"\$@\""
      return $?
    }
    cmd_override=$1
    pos_array=$2
    shift 2
  fi
  [[ $pos_array =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    _sha_opt_error "用法: sha_opt_parse [--cmd CMD] <pos_array> \"\$@\""
    return $?
  }
  if [[ -n $cmd_override ]]; then caller=$cmd_override; else caller=${FUNCNAME[1]:-}; fi
  [[ -n $caller ]] || { _sha_opt_error "sha_opt_parse 必须在命令函数内调用"; return $?; }
  local cmd=""
  _sha_opt_norm_cmd "$caller" cmd

  # pos 数组名不得与本命令/全局的选项变量重名，否则位置参数无处可写
  local cv
  for cv in ${_SHA_OPT_ORDER[$cmd]:-} ${_SHA_OPT_ORDER['*']:-}; do
    if [[ $cv == "$pos_array" ]]; then
      _sha_opt_error "位置数组 [$pos_array] 与选项变量重名"
      return $?
    fi
  done

  declare -n _sha_pos="$pos_array" 2>/dev/null || {
    _sha_opt_error "[$cmd] 位置数组 [$pos_array] 非法"
    return $?
  }
  _sha_pos=() 2>/dev/null || { _sha_opt_error "[$cmd] [$pos_array] 必须是数组 (local -a)"; return $?; }

  # 初值: 只回填已声明的变量 (opt-in，不强制函数声明全部选项)；
  # 传了某选项却没声明对应 local，赋值时报错 (防写穿全局)。
  local v key type
  local -A _sha_seen=()
  for v in ${_SHA_OPT_ORDER[$cmd]:-}; do
    key="$cmd|$v"
    _sha_seen[$v]=1
    declare -p "$v" >/dev/null 2>&1 || continue
    type=${_SHA_OPT_TYPE[$key]}
    declare -n _sha_init="$v"
    case $type in
      list) _sha_init=() ;;
      bool) _sha_init=0 ;;
      *) _sha_init=${_SHA_OPT_DEFAULT[$key]:-} ;;
    esac
  done
  for v in ${_SHA_OPT_ORDER['*']:-}; do
    [[ -n ${_sha_seen[$v]:-} ]] && continue
    _sha_seen[$v]=1
    key="*|$v"
    declare -p "$v" >/dev/null 2>&1 || continue
    type=${_SHA_OPT_TYPE[$key]}
    declare -n _sha_init="$v"
    case $type in
      list) _sha_init=() ;;
      bool) _sha_init=0 ;;
      *) _sha_init=${_SHA_OPT_DEFAULT[$key]:-} ;;
    esac
  done

  local -A _given=()
  local a name value key2 found
  local re_int='^[+-]?[0-9]+$'
  while (($#)); do
    case $1 in
      --)
        shift
        while (($#)); do _sha_pos+=("$1"); shift; done
        break
        ;;
      -h|--help)
        _sha_opt_print_help "$cmd"
        return 2
        ;;
      --no-*)
        name=${1#--no-}
        key2=$(_sha_opt_find_long "$cmd" "$name") && found=1 || found=0
        if (( ! found )) || [[ ${_SHA_OPT_TYPE[$key2]} != "bool" ]]; then
          _sha_opt_error "unknown option [$1] for [$cmd] (--no- 只用于 bool)，valid: $(_sha_opt_valid_list "$cmd")"
          return $?
        fi
        _sha_opt_take_value "$key2" "false" || return $?
        shift
        ;;
      --*=*)
        name=${1%%=*}; name=${name#--}
        value=${1#*=}
        key2=$(_sha_opt_find_long "$cmd" "$name") && found=1 || found=0
        if (( ! found )); then
          _sha_opt_error "unknown option [--$name] for [$cmd]，valid: $(_sha_opt_valid_list "$cmd")"
          return $?
        fi
        _sha_opt_take_value "$key2" "$value" || return $?
        shift
        ;;
      --*)
        name=${1#--}
        key2=$(_sha_opt_find_long "$cmd" "$name") && found=1 || found=0
        if (( ! found )); then
          _sha_opt_error "unknown option [$1] for [$cmd]，valid: $(_sha_opt_valid_list "$cmd")"
          return $?
        fi
        if [[ ${_SHA_OPT_TYPE[$key2]} == "bool" ]]; then
          _sha_opt_take_value "$key2" "true" || return $?
          shift
        else
          (( $# >= 2 )) || { _sha_opt_error "option [$1] requires a value"; return $?; }
          _sha_opt_take_value "$key2" "$2" || return $?
          shift 2
        fi
        ;;
      -?*)
        a=$1
        if [[ ${#a} -eq 2 || ( ${#a} -gt 3 && ${a:2:1} == "=" ) ]]; then
          local ch=${a:1:1}
          key2=$(_sha_opt_find_short "$cmd" "$ch") && found=1 || found=0
          if (( ! found )); then
            _sha_opt_error "unknown option [$a] for [$cmd] (v1 只支持 --long)，valid: $(_sha_opt_valid_list "$cmd")"
            return $?
          fi
          if [[ ${_SHA_OPT_TYPE[$key2]} == "bool" ]]; then
            if [[ $a == *=* ]]; then
              _sha_opt_take_value "$key2" "${a#*=}" || return $?
            else
              _sha_opt_take_value "$key2" "true" || return $?
            fi
            shift
          else
            if [[ $a == *=* ]]; then
              _sha_opt_take_value "$key2" "${a#*=}" || return $?
              shift
            else
              (( $# >= 2 )) || { _sha_opt_error "option [$a] requires a value"; return $?; }
              _sha_opt_take_value "$key2" "$2" || return $?
              shift 2
            fi
          fi
        elif [[ $a == "-" ]]; then
          _sha_pos+=("$1"); shift
        else
          _sha_opt_error "unknown option [$a] for [$cmd] (短选项不支持合写/贴写)，valid: $(_sha_opt_valid_list "$cmd")"
          return $?
        fi
        ;;
      *)
        _sha_pos+=("$1"); shift
        ;;
    esac
  done

  # 必填校验: 未出现或空值都算缺
  for v in ${_SHA_OPT_ORDER[$cmd]:-}; do
    key="$cmd|$v"
    (( ${_SHA_OPT_REQUIRED[$key]:-0} )) || continue
    type=${_SHA_OPT_TYPE[$key]}
    if [[ -z ${_given[$key]:-} ]]; then
      _sha_opt_error "option [${_SHA_OPT_LONG[$key]}] is required"
      return $?
    fi
    if [[ $type != "list" ]]; then
      declare -n _sha_chk="$v"
      if [[ -z $_sha_chk ]]; then
        _sha_opt_error "option [${_SHA_OPT_LONG[$key]}] is required (不接受空值)"
        return $?
      fi
    fi
  done

  # 位置参数校验: 仅当本命令声明了 args；未声明则保持透传兼容
  if [[ -n ${_SHA_OPT_ARGS[$cmd]:-} ]]; then
    local -a _names=(${_SHA_OPT_ARGS[$cmd]})
    local i=0 an
    for an in "${_names[@]}"; do
      local akey="$cmd|$an"
      local areq=${_SHA_OPT_ARG_REQ[$akey]:-0} arest=${_SHA_OPT_ARG_REST[$akey]:-0}
      if (( arest )); then
        if (( areq && ${#_sha_pos[@]} <= i )); then
          _sha_opt_error "missing argument <$an...> for [$cmd] (至少需要 1 个)"
          return $?
        fi
        i=${#_sha_pos[@]}
      elif (( i < ${#_sha_pos[@]} )); then
        i=$((i+1))
      elif (( areq )); then
        _sha_opt_error "missing argument <$an> for [$cmd]"
        return $?
      fi
    done
    if (( i < ${#_sha_pos[@]} )); then
      _sha_opt_error "unexpected argument [${_sha_pos[$i]}] for [$cmd]"
      return $?
    fi
    # 按 --arg 声明的名字写回（与选项同一约定: 名字已 local 声明才写，不向全局写穿）
    #   --arg FILE!    -> 标量变量 FILE
    #   --arg FILES... -> 数组变量 FILES（吃掉剩余全部）
    # 数组赋值走 nameref：调用者写成局部标量也 OK，bash 会自动提升为数组；
    # 但几十行前那个 declare -p 存在性检查不能省 —— 无名可引用时 nameref 会直接
    # 造一个同名全局变量（实测），那就写穿了。
    i=0
    for an in "${_names[@]}"; do
      local akey="$cmd|$an"
      local arest=${_SHA_OPT_ARG_REST[$akey]:-0}
      if (( arest )); then
        if declare -p "$an" >/dev/null 2>&1; then
          declare -n _sha_argref="$an"
          _sha_argref=("${_sha_pos[@]:i}")
          unset -n _sha_argref
        fi
        i=${#_sha_pos[@]}
      else
        [[ $i -lt ${#_sha_pos[@]} ]] && declare -p "$an" >/dev/null 2>&1 \
          && printf -v "$an" '%s' "${_sha_pos[i]}"
        i=$((i+1))
      fi
    done
  fi
  return 0
}

# 内部: 给 key 赋值 (上层已做 unknown 检查；未声明 local 在此报错)
_sha_opt_take_value() {
  local key=$1 value=$2
  local type=${_SHA_OPT_TYPE[$key]} v=${key#*|}
  local enum=${_SHA_OPT_ENUM[$key]} long=${_SHA_OPT_LONG[$key]}
  if ! declare -p "$v" >/dev/null 2>&1; then
    _sha_opt_error "必须先声明 local $v 再用 [$long] (防写穿成全局变量)"
    return $?
  fi
  if [[ -z $value && $type != "bool" && $type != "list" && ${_SHA_OPT_REQUIRED[$key]:-0} == "1" ]]; then
    _sha_opt_error "option [$long] is required (不接受空值)"
    return $?
  fi
  if [[ $type == "bool" ]]; then
    local w=${value,,} flag=""
    case $w in
      1|true|yes|on) flag=1 ;;
      0|false|no|off) flag=0 ;;
      *)
        _sha_opt_error "option [$long] bool 值非法 [$value] (true/false/1/0/yes/no/on/off)"
        return $?
        ;;
    esac
    declare -n _sha_set="$v"; _sha_set=$flag
    _given[$key]=1
    return 0
  fi
  if [[ $type == "int" ]]; then
    local re_int='^[+-]?[0-9]+$'
    [[ $value =~ $re_int ]] || { _sha_opt_error "option [$long] must be an integer, got [$value]"; return $?; }
  fi
  if [[ -n $enum ]]; then
    local found=0 l
    IFS='|' read -ra _sha_opt_lits <<<"$enum"
    for l in ${_sha_opt_lits[@]+"${_sha_opt_lits[@]}"}; do
      [[ $l == "$value" ]] && found=1
    done
    if (( ! found )); then
      _sha_opt_error "option [$long] must be one of $enum, got [$value]"
      return $?
    fi
  fi
  declare -n _sha_set="$v"
  if [[ $type == "list" ]]; then
    _sha_set+=("$value")
  else
    _sha_set=$value
  fi
  _given[$key]=1
}

##################################################################################################
### 自举: sha.def 自己的参数也用 option 语法声明
### (调用者函数名 "sha.def" 按 . 分层映射到命令路径 "sha def"，正好命中本表)
##################################################################################################

# 本表顺序与用户侧约定一致：选项 / 位置参数在前，--desc 最后
sha.option "sha def" \
  "--opt:list:选项定义 (可重复)" \
  "--arg:list:位置参数定义 (可重复)" \
  "--desc:string:说明 (首行一句话, 其余行为补充说明, 可用换行分隔)"

##################################################################################################
### sha.parse: 命令函数体里的解析入口（跑狗粮：底层是 sha_opt_parse）
###   宗旨: sha.def 声明了什么就只解析什么。没声明的选项、没声明的位置参数，
###         一律当“参数用错”报错并打印 usage（而不是默默收进一个兜底数组）。
##################################################################################################

# 用法: sha.parse "$@"
#   选项 -> 同名 local 变量；位置参数 -> --arg 里声明的名字
#     --arg "FILE!"      -> 标量 local FILE
#     --arg "FILES..."   -> 数组 local -a FILES
#   声明了却没 local 同名变量，或没声明却传了位置参数，都报错并提示 usage。
#   单独调 sha.parse -h 只看本函数的用法。
sha.parse() {
  local _sha_parse_cmd=${FUNCNAME[1]:-} _sha_parse_norm=""
  case ${1:-} in
    -h | --help)
      printf '%s\n' "usage: sha.parse \"\$@\"" \
        "  选项：写回同名 local 变量；位置参数：写回 --arg 声明的名字" \
        "    --arg \"FILE!\"    -> 标量 local FILE" \
        "    --arg \"FILES...\" -> 数组 local -a FILES" \
        "  没声明的东西一律报错：先 sha.def 声明，或别传" \
        "  当前调用者: ${_sha_parse_cmd:-<顶层，非命令函数>}"
      return 0
      ;;
  esac
  [[ -n $_sha_parse_cmd ]] || { _sha_opt_error "sha.parse 必须在命令函数内调用"; return $?; }
  _sha_opt_norm_cmd "$_sha_parse_cmd" _sha_parse_norm

  # 声明了名字就必须能写：调用方先 local（与选项同一约定: 防写穿全局）
  local _sha_parse_an
  for _sha_parse_an in ${_SHA_OPT_ARGS[$_sha_parse_norm]:-}; do
    declare -p "$_sha_parse_an" >/dev/null 2>&1 || {
      _sha_opt_error "必须先声明 local $_sha_parse_an（--arg 已声明它，但函数里没局部变量）"
      _sha_opt_print_usage "$_sha_parse_norm"
      return 1
    }
  done

  # 内部用私有数组接抛出物（不让调用方再维护一个 args 数组）
  local -a _sha_parse_pos=()
  sha_opt_parse --cmd "$_sha_parse_cmd" _sha_parse_pos "$@" || return $?

  # 没声明 --arg 却真给了位置参数：当参数用错（不提供默认 args 兜底）
  (( ${#_sha_parse_pos[@]} )) || return 0
  if [[ -z ${_SHA_OPT_ARGS[$_sha_parse_norm]:-} ]]; then
    _sha_opt_error "[$_sha_parse_cmd] 不接受位置参数 [${_sha_parse_pos[*]}]（未声明 --arg）"
    _sha_opt_print_usage "$_sha_parse_norm"
    return 1
  fi
  return 0
}

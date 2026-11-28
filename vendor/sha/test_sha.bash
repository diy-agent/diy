#!/usr/bin/env bash
set -o errtrace  # -E trap inherited in sub script
set -o errexit   # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail
#set -o nounset # -u: 当尝试使用未定义的变量时，立即报错并退出脚本。这有助于防止因变量拼写错误或未初始化导致的意外行为。
                #  don't use it ,it is crazy,
                #   1.bash version is diff Behavior
                #   2.we need like this: ${arr[@]+"${arr[@]}"}
                #   3.影响使用此lib的脚本

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEST_PATH=$(basename "$TEST_DIR")

# shellcheck disable=SC1091
source "$TEST_DIR/unit_test_framework.bash"
# shellcheck disable=SC1091
source "$TEST_DIR/sha.bash"

# 约定: 每个 test_ 用例自带 fixture (命令函数定义在用例内部，一眼能看到全貌)。
# 自注册约定: a.b.c() / a__b__c() → sha a b c ; 单个 _ 不拆分 ; _ 开头不注册。
#
# 同进程隔离运行一次 sha 调用: 函数定义和 _SHA_* 表修改都在 $(...) 子 shell 里,
# 父进程状态永远干净, 用例之间天然隔离, 无需 bash -c 起新进程。
# (sha 已改 exit→return; $(...) 本身就是一次 fork, 比 bash -c 快一个数量级)
# 用法: sha_run <fixture_setup_func> <cmd...> -- fixture 里只定义命令函数
#   输出: 被测命令的 stdout (stderr 重定向到 stdout, 方便断言 help/报错)
#   返回码: 0 成功, 1 未知命令/注册失败, 3 纯分组缺子命令
sha_run() { "$@" 2>&1; }


test_all_funcname_is_ok() {
  fixture() {
    a() { echo "a"; }
    b() { echo "b"; }
    sha "$@"
  }
  assert_equals "a" "$(sha_run fixture a)"
  assert_equals "b" "$(sha_run fixture b)"
}

test_sub_command() {
  fixture() {
    a() { echo "a"; }
    b() { echo "b"; }          # 有实现的父命令
    b.b1() { echo "b/b1"; }    # 点分式子命令
    b.b2() { echo "b/b2"; }
    sha "$@"
  }
  assert_equals "a" "$(sha_run fixture a)"
  assert_equals "b/b1" "$(sha_run fixture b b1)"
  assert_equals "b/b2" "$(sha_run fixture b b2)"
}

# 有实现的父命令: 无额外参数时执行自己, 不打印 help
test_parent_with_func_runs() {
  fixture() {
    b() { echo "b"; }
    b.b1() { echo "b/b1"; }
    sha "$@"
  }
  assert_equals "b" "$(sha_run fixture b)"
}

# 内外层同名不再互相覆盖, 各用各的全名 (旧嵌套式的遮蔽坑已终结)
test_duplicated_command() {
  fixture() {
    aaa() { echo "aaa"; }
    bbb() { echo "bbb"; }
    bbb.aaa() { echo "bbb/aaa"; }
    bbb.bbb() { echo "bbb/bbb"; }
    sha "$@"
  }
  assert_equals "aaa" "$(sha_run fixture aaa)"
  assert_equals "bbb" "$(sha_run fixture bbb)"
  assert_equals "bbb/aaa" "$(sha_run fixture bbb aaa)"
  assert_equals "bbb/bbb" "$(sha_run fixture bbb bbb)"
}

# 纯分组 (g 自己没有函数, 只有子命令): 无参给 help+3, 未知子命令给 1
test_pure_group() {
  fixture() {
    g.g1() { echo "g/g1"; }
    sha "$@"
  }
  local status=0
  sha_run fixture g >/dev/null 2>&1 || status=$?
  assert_equals "3" "$status"
  assert_contains "g1" "$(sha_run fixture g)"
  status=0
  sha_run fixture g bad >/dev/null 2>&1 || status=$?
  assert_equals "1" "$status"
}

# __ 拆成层级、单个 _ 不拆分 (保护 snake_case)
test_separators() {
  fixture() {
    e__e1() { echo "e/e1"; }    # __ → 层级
    my_cmd() { echo "my_cmd"; } # 单个 _ 不拆, 就是单命令
    sha "$@"
  }
  assert_equals "e/e1" "$(sha_run fixture e e1)"
  assert_equals "my_cmd" "$(sha_run fixture my_cmd)"
}

# root 函数: sha 无参时执行它
test_root_func() {
  fixture() {
    root() { echo "i am root"; }
    sha "$@"
  }
  assert_equals "i am root" "$(sha_run fixture)"
}

# 路径撞车 (c.d 与 c__d 映射到同一路径) 必须报错, 不能静默覆盖
test_collision_errors() {
  fixture() {
    c.d() { echo "dot"; }
    c__d() { echo "under"; }
    sha "$@"
  }
  local status=0
  local out
  out=$(sha_run fixture a 2>&1) || status=$?
  assert_equals "1" "$status"
  assert_contains "撞车" "$out"
}

# 同进程调两次 sha, 第二次行为必须与第一次一致 (旧 diff 模型的重入 bug 回归测试)
test_reentry_same_process() {
  fixture() {
    a() { echo "a"; }
    sha "$@"
  }
  # 真重入: 同一个 shell 里连调, 第一次输出落文件 (不用 $(...), 不开新子 shell),
  # 第二次行为必须与全新进程一致 (旧 diff 模型在这里静默 return 0)。
  local status=0 reentry_out=/tmp/sha_reentry_$BASHPID.txt
  fixture a >"$reentry_out" 2>&1 || status=$?
  assert_equals "0" "$status"
  assert_equals "a" "$(<"$reentry_out")"
  assert_equals "a" "$(sha_run fixture a)"
  status=0
  fixture no_such >/dev/null 2>&1 || status=$?
  assert_equals "1" "$status"
  assert_contains "unknown command" "$(sha_run fixture no_such)"
  rm -f "$reentry_out"
}

test_unknown_command_returns_1() {
  fixture() {
    a() { echo "a"; }
    sha "$@"
  }
  local status=0
  sha_run fixture no_such_cmd >/dev/null 2>&1 || status=$?
  assert_equals "1" "$status"
  assert_contains "unknown command" "$(sha_run fixture no_such_cmd)"
}

test_parent_without_subcommand_returns_3() {
  fixture_group() {
    g.g1() { echo "g/g1"; }
    sha "$@"
  }
  fixture_plain() {
    a() { echo "a"; }
    sha "$@"
  }
  local status=0
  sha_run fixture_group g >/dev/null 2>&1 || status=$?
  assert_equals "3" "$status"
  status=0
  sha_run fixture_plain >/dev/null 2>&1 || status=$?
  assert_equals "3" "$status"
}

# 命令名不带 / 后缀; 父命令的 help 里要列出下一层（分发层与 option 层一致）
test_help_flag() {
  fixture() {
    b() { echo "b"; }
    b.b1() { echo "b/b1"; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture --help)
  assert_contains "  b" "$out"
  case $out in *"b/"*) return 1 ;; esac
  out=$(sha_run fixture b --help)
  assert_contains "b1" "$out"
  case $out in *"b/"*) return 1 ;; esac
}

# 函数注释 → 帮助: 紧邻定义行上方的连续 #: 块, 首行 = 子命令列表里的简要帮助
test_doc_comment_in_list() {
  fixture() {
    #: 构建全部产物
    #: 用法: sha build [--target T]
    build() { :; }
    #: 只构建 web
    build.web() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture --help)
  assert_contains "构建全部产物" "$out"
  # 父层 help 列出下一层, 且用子命令自己的注释
  out=$(sha_run fixture build --help)
  assert_contains "只构建 web" "$out"
}

# -h 叠写: -h 只本层, -hh / -hhh 打开整棵树（子树缩进）
test_doc_hh_whole_tree() {
  fixture() {
    #: 一级 a
    a() { :; }
    #: 二级 b
    a.b() { :; }
    #: 三级 c
    a.b.c() { :; }
    #: 一级 f
    f() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture -h)
  assert_contains "  a  一级 a" "$out"
  case $out in *"  b"*) return 1 ;; esac     # 一层不露子项
  out=$(sha_run fixture -hh)
  assert_contains "  a  一级 a" "$out"
  assert_contains "    b  二级 b" "$out"
  assert_contains "      c  三级 c" "$out"
  # 多于两个 h 也是全树
  out=$(sha_run fixture -hhh)
  assert_contains "      c  三级 c" "$out"
  # --help 只一层
  out=$(sha_run fixture --help)
  case $out in *"  b"*) return 1 ;; esac
  return 0
}

# -h 后面不是全 h: 当普通参数（未知命令 rc=1），不当 help
test_doc_hx_is_unknown() {
  fixture() {
    a() { :; }
    sha "$@"
  }
  local status=0
  sha_run fixture -hx >/dev/null 2>&1 || status=$?
  assert_equals "1" "$status"
  return 0
}

# 普通 # 注释是实现备注, 不算帮助 (只认 #:)
test_doc_plain_comment_ignored() {
  fixture() {
    # 这是实现备注, 不该出现在 help 里
    plain() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture --help)
  assert_contains "plain" "$out"
  case $out in *实现备注*) return 1 ;; esac
  return 0
}

# 与函数定义之间隔了空行就不是紧邻, 不取
test_doc_blank_line_breaks_block() {
  fixture() {
    #: 隔了空行不该生效

    far() { :; }
    sha "$@"
  }
  local out
  out=$(sha_run fixture --help)
  assert_contains "far" "$out"
  case $out in *不该生效*) return 1 ;; esac
  return 0
}

# extdebug 是全局 shopt: 原本开着不能被关掉, 原本关着不能残留
test_doc_extdebug_restored() {
  fixture() {
    #: 有注释的命令
    a() { :; }
    sha "$@"
  }
  shopt -s extdebug
  sha_run fixture --help >/dev/null
  shopt -q extdebug || { shopt -u extdebug; return 1; }
  shopt -u extdebug
  sha_run fixture --help >/dev/null
  shopt -q extdebug && return 1
  return 0
}


run_tests

#!/usr/bin/env bash
set -o errtrace # -E trap inherited in sub script
set -o errexit # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail
#set -o nounset # -u: don't use it ,it is crazy, 1.bash version is diff Behavior 2.we need like this: ${arr[@]+"${arr[@]}"}




assert_fail() {
  echo "$@" >&2
}


# 测试没有第二个参数的情况，从标准输入读取
# echo "test" | assert_equals "test"
# 测试有第二个参数的情况，使用第二个参数作为内容
# assert_equals "x" "x"

assert_equals(){
  local expected="$1"  actual="$2"

  if [[ "$actual" != "$expected" ]] ; then
    local error_message;
    # shellcheck disable=SC2261
    # 'printf %s' 将其对应的参数字符串视为纯粹的字符串，不会解释其中的反斜杠转义序列。
    # 这与 echo 不带 -e 参数时的默认行为（在许多现代 Shell 中是 -E 的效果）一致。
    error_message=$(cat <<ERROR_END

=====================error - <check use: printf "%s">======================
expected: [$(printf "%s" "$expected")]
actual  : [$(printf "%s" "$actual")]
===========================================================================

ERROR_END
)
    echo -E "$error_message" >&2
    # 可以用vimdiff看细节
    return 1
  fi
}
assert_contains(){
  local expected="$1" actual="$2"  msg="$3"
  if [[ "$actual" != *"$expected"* ]] ; then
    assert_fail "assert fail: $msg
     actual         : [$actual]
     is not contains: [$expected]"
     return 2
  fi
}


# 查找出所有"test_"开头的函数并执行
# 单个用例失败只计数不中断, 最后汇总返回非零 (用 if 接住, 否则 set -e 会直接杀掉整个测试进程)
function run_tests(){
      local failed=0 total=0
      while IFS=$'\n' read -r functionName ; do
        [[ "$functionName" != test_* ]] && continue ;
        total=$((total+1))
        # run test
        printf "test: %s %-50s" "${TEST_PATH}" "$functionName()"
        # TIMEFORMAT: https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html
        # %R==real %U==user %S==sys %P==(user+sys)/real
        TIMEFORMAT="real %R user %U sys %S percent %P"
        # P0 修: 不能用 if ( time ... ) 包测试 —— condition context 会关掉子 shell
        # 里的 set -e, assert 失败后只要后面还有成功的 assert, 用例仍会 PASS。
        # 改法: 外层 set +e, 子 shell 里显式 set -e, 状态码自己取。
        local status _e_was_on=0
        case $- in *e*) _e_was_on=1;; esac
        set +e
        (
          # 隔离test在子shell里，防止环境互相影响
          set -e
          time "$functionName" ;
        )
        status=$?
        if (( _e_was_on )); then set -e; fi
        if (( status == 0 )); then
          echo "PASS: $functionName"
        else
          echo "FAIL: $functionName (rc=$status)"
          failed=$((failed+1))
        fi # 2>&1
  #    done <<< "$(compgen -A function)" # 还是declare -F 再过滤保险
      done < <(compgen -A function)
      echo "----------------------------------------"
      echo "tests: total=$total failed=$failed"
      return "$failed"
}
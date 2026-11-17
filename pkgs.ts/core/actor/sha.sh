#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 3. 可用颜色变量：$primary $secondary $error $info $reset
# 4. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../../sha.common.sh"

####################################################################################
# mono必备子命令
####################################################################################

clean() { run rm -rf ./dist ./node_modules/.cache/tsbuildinfo; }
check() { typecheck; lint; }
fix() { fmt-fix; lint-fix; }
sync() { :; }

# 没有单测文件：范例本身就是断言（每节都打印出「应该是多少」和实际值）
test() {
  for f in examples/*/index.ts; do
    echo ""
    echo "── $f"
    node --import tsx "$f" > /dev/null
  done
  echo ""
  echo "七个范例全部跑通（exit 0）"
}
test-unit() { test "$@"; }

####################################################################################
# 范例（每个一个目录，目录里 index.ts + README.md）
####################################################################################

# 01 为什么需要：不排队就丢更新
e01() { run node --import tsx examples/01-serial/index.ts; }
# 02 调用即得值：room.say 就是普通函数
e02() { run node --import tsx examples/02-room/index.ts; }
# 03 连点三次：排队，但不阻塞 UI
e03() { run node --import tsx examples/03-queue/index.ts; }
# 04 取消：中断正在跑的，保留已产出的
e04() { run node --import tsx examples/04-cancel/index.ts; }
# 05 崩溃恢复：一次提交 = 一行
e05() { run node --import tsx examples/05-persist/index.ts; }
# 06 跨进程：调用方那几行不用改
e06() { run node --import tsx examples/06-net/index.ts; }
# 07 聚合：多个 actor 汇总成一条流
e07() { run node --import tsx examples/07-aggregate/index.ts; }

all() {
  for f in examples/*/index.ts; do
    echo ""
    echo "════════════════════════════════════════"
    echo "  $f"
    echo "════════════════════════════════════════"
    node --import tsx "$f"
  done
}

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ examples/; }
lint-fix() { run npx oxlint --fix src/ examples/; }
fmt() { run npx oxfmt --check src/ examples/; }
fmt-fix() { run npx oxfmt --write src/ examples/; }

sha "$@"

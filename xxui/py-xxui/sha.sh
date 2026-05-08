#!/usr/bin/env bash

# Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
# shellcheck disable=SC2329 # This function is never invoked. Check usage (or ignored if invoked indirectly).shellcheckSC2329
# shellcheck disable=SC2317
# shellcheck disable=SC2034 #secondary appears unused. Verify use (or export if used externally).shellcheckSC2034
set -o errtrace  # -E trap inherited in sub script
set -o errexit   # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail

## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar
## 开启后可用排除语法：_workspaces=(~ ~/git/chen56/!(applab)/ ~/git/botsay/*/ )
shopt -s extglob

# Get the real path of the script directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"
source "../../sha_common.sh"

####################################################################################
# GitHub Project 工作流配置
####################################################################################

clean() {
  run rm -rf ./build
  run rm -rf ./dist
}

test() {
  run uv run pytest "${@:-tests/}"
}

check() {
  run uv run ruff check src/ tests/
  run uv run ruff format --check src/ tests/
  test "$@"
}

fix() {
  run uv run ruff check --fix src/ tests/
  run uv run ruff format src/ tests/
}

panel() {
  run uv run panel serve examples/*.pn.py
}
####################################################
# app entry script & _root cmd
####################################################

sha "$@"


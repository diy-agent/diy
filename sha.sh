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
ROOT_PATH="$(realpath "$(command -v "${BASH_SOURCE[0]}")")"
ROOT_DIR="$(dirname "$C_MAC_PATH")"

cd "$ROOT_DIR"
source sha.common.sh

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################
check() { :; }
ci() { :; }
clean() {
  run rm -rf ./build
  run rm -rf ./dist
  run rm -rf .venv
  run rm -rf .nodemodules
}
fix()   {  :; }
sync() {
  run uv sync
  run npm i
  run git submodule update --init --recursive
  # run run npx tsx packages/diy-cli/src/diy/cli.ts sync
}
test()   {  :; }

####################################################
# other
####################################################
cli() {
  run npx tsx packages/diy-cli/src/diy/cli.ts "$@"
}
install() {
  run uv tool install -e packages/diydev
}
####################################################
# app entry script & _root cmd
####################################################

sha "$@"

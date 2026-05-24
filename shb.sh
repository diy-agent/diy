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

# _workspaces=(packages/*/ pkgs-diyui/*/)
_workspaces=(. packages/*/)
_vendors=(vendor/*/)

_ws_run() {
  for ws in "${_workspaces[@]}"; do
    (
      cd "$ws"
      echo "${inverse_surface}info: workspace: Running '$@' in '$ws'${reset}"
      run "$@"
    )
  done
}

pwd()   {  _ws_run command pwd; }
exec()  {  _ws_run command "$@"; }
clean() {  _ws_run command ./sha.sh clean; }
sync()  {  _ws_run command ./sha.sh sync; }
ci()    {  _ws_run command ./sha.sh ci; }
check() {  _ws_run command ./sha.sh check; }
fix()   {  _ws_run command ./sha.sh fix; }
test()  {  _ws_run command ./sha.sh test; }
sync() {
  run uv sync --all-packages
  run npm i --workspaces
  run git submodule update --init --recursive
  _ws_run command ./sha.sh sync;
}

_vendors_run() {
  for submodule in "${_vendors[@]}"; do
    (
      cd "$submodule"
      run "$@"
    )
  done
}

# 直接改submoulde代码推荐流程：
#  ```bash
#    # 1. 进入子模块，先切到分支
#    cd vendor/sha
#    git checkout main

#    # 2. 正常改代码、提交、推送
#    git add .
#    git commit -m "feat: xxx"
#    git push origin main

#    # 3. 回到父仓库，更新子模块指针
#    cd ../..
#    git add vendor/sha
#    git commit -m "chore: update vendor/sha"
#  ```
vendor() {
  exec()    { _vendors_run command "$@"; }
  status()  { _vendors_run git status; }
  update() {  run git submodule update --init --recursive --remote --merge; }
}

####################################################
# other
####################################################
cli() {
  run npx tsx packages/diy-cli/src/diy/cli.ts "$@"
}

####################################################
# app entry script & _root cmd
####################################################

sha "$@"

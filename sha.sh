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

# _workspaces=(pkgs/*/)
_workspaces=(pkgs.ts/*/)
_vendors=(vendor/*/)

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################

_ws_run() {
  for ws in "${_workspaces[@]}"; do
    (
      cd "$ws"
      echo "${inverse_surface}info: workspace: Running '$@' in '$ws'${reset}"
      run "$@"
    )
  done
}

# mono所有workspaced项目上执行一条命令
exec()  {  _ws_run command "$@"; }
# build() {  _ws_run command ./sha.sh build; }
# mono所有workspaced的clean,包括删除build/dist等
#（各包 out/ 由自家 ./sha.sh clean 负责，见 pkgs.ts/*/sha.sh）
clean() {
    run rm -rf ./build
    run rm -rf ./dist
    run rm -rf .venv
    run rm -rf .nodemodules
    _ws_run command ./sha.sh clean;
}

# mono所有workspaced的sync,包括uv sync、ln软链接到全局执行文件等
sync()  {
    run npm i --workspaces
    run git submodule update --init --recursive

    _ws_run command ./sha.sh sync;
}
link() {      _ws_run command npm link; }
unlink() {    _ws_run command npm unlink -g ; }
# 全仓唯一检查入口：全项目类型 + 全仓 lint + rpc 浏览器安全 + 产物护栏
#（子包目录下单用见 pkgs.ts/*/sha.sh check）
check() {
  run npx tsc -b tsconfig.all.json --noEmit
  run npx oxlint pkgs.ts/
  run npx tsc --noEmit -p pkgs.ts/diy-rpc/tsconfig.browser.json
  # 产物护栏：TS 包源码目录旁不得出现编译产物（实现见 scripts/check-no-emit.sh）
  run bash scripts/check-no-emit.sh
}
# 全仓唯一自动修复入口：格式化 + lint 可修项，能修的全修
fix() {
  run npx oxfmt --write pkgs.ts/
  run npx oxlint --fix pkgs.ts/
}
# 全部测试：两包快速单测 + 构建 + diy-app 意图测试（起隔离 Electron，最慢放最后）
test() {
  _ws_run command ./sha.sh test
}
# 编程中快速验证：两包单测，不构建、不起 Electron
test-unit() {  _ws_run command ./sha.sh test-unit; }

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
# Python 包发布
####################################################
build() {
    # 构建只在 diy-app（含 cli 产物），细节见 pkgs.ts/diy-app/sha.sh build
    run ./pkgs.ts/diy-app/sha.sh build
}

ci() {
    clean
    test
    build
    # test: 验证构建产物
    echo "${info}构建产物:${reset}"
    run ls -lh ./dist/
}

publish() {
  :
}

# mono所有workspace的ci持续集成,包括check;test;
github-actions-cicd()    {
    # github actions 安装 playwright 依赖
    uv run playwright install chromium --with-deps
    ci
    publish
}

dev() { pkgs.ts/diy-app/sha.sh dev; }


####################################################
# app entry script & _root cmd
####################################################

sha "$@"

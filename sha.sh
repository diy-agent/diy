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
_workspaces=(pkgs/*/)
_vendors=(vendor/*/)

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################
#
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
clean() {
    run rm -rf ./build
    run rm -rf ./dist
    run rm -rf .venv
    run rm -rf .nodemodules
    _ws_run command ./sha.sh clean;
}

# mono所有workspaced的sync,包括uv sync、ln软链接到全局执行文件等
sync()  {
    link
    run uv sync --all-packages
    # run npm i --workspaces
    run git submodule update --init --recursive

    _ws_run command ./sha.sh sync;
}
link() {  _ws_run command ./sha.sh unlink; }
# mono所有workspace的代码检查(ruff等)
check() {  _ws_run command ./sha.sh check; }
# mono所有workspace的代码自动修复(ruff等)
fix()   {  _ws_run command ./sha.sh fix; }
# mono所有workspace的单元测试
test()  {  _ws_run command ./sha.sh test; }
# mono所有workspace项目的所有测试，包括浏览器测试
test-all()  {  _ws_run command ./sha.sh test-all; }

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
    run uv build --all-packages
}
ci() {
    clean
    test-all
    build
    # test: 验证构建产物
    echo "${info}构建产物:${reset}"
    run ls -lh ./dist/
}

publish() {
  local token="${UV_PUBLISH_TOKEN:-$1}"
  if [[ -z "$token" ]]; then
    echo "${error}错误: 需要 UV_PUBLISH_TOKEN 环境变量或传入 token 参数${reset}"
    echo "用法: ./sha.sh publish [:token <token>]"
    return 1
  fi

  # 发布
  echo "${info}发布到 PyPI...${reset}"
  run uv publish --token "$token"

  echo "${success}✓ 发布完成${reset}"
}
# mono所有workspace的ci持续集成,包括check;test-all;
github-actions-cicd()    {
    # github actions 安装 playwright 依赖
    uv run playwright install chromium --with-deps
    ci
    publish
}


####################################################
# app entry script & _root cmd
####################################################

# 隔离实验模式（数据在 .diy-dev/）
# 用法: DIY_HOME=.diy-dev uv run diy task ...
dev() {
  echo "隔离模式: 数据目录 .diy-dev/"
  echo "用法: DIY_HOME=.diy-dev uv run diy task ..."
}

sha "$@"

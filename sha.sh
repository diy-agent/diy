#!/usr/bin/env bash

# Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
# shellcheck disable=SC2317

# c_primary is referenced but not assigned.
# shellcheck disable=SC2154

set -o errtrace  # -E trap inherited in sub script
set -o errexit   # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail

## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar
## 开启后可用排除语法：workspaces=(~ ~/git/chen56/!(applab)/ ~/git/botsay/*/ )
shopt -s extglob

# Get the real path of the script directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/sha_common.sh"

# 全局命令不要进入到_c目录
# cd "$ROOT_DIR"

workspaces=(packages/*/)
submodules=(vendor/*/)
worktree_dir=".worktree"

####################################################################################
# worktree 开发流程 (方案 B: 脚本 + AGENTS.md 双重保障)
####################################################################################
# 使用示例:
#   ./sha.sh worktree add dao-feature-xxx       # 创建新 worktree 分支
#   ./sha.sh worktree status                    # 查看所有 worktree 状态
#   ./sha.sh worktree remove dao-feature-xxx    # 清理已合并的 worktree
#   ./sha.sh worktree merge dao-feature-xxx     # 合并 worktree 到 main 并清理
####################################################################################
worktree() {
  
  # 列出所有 worktree 状态
  list() {
    # 获取主分支名称（main 或 master）
    local main_branch="main"
    if ! git show-ref --verify --quiet "refs/heads/main"; then
      if git show-ref --verify --quiet "refs/heads/master"; then
        main_branch="master"
      fi
    fi

    # 表头，缩短路径显示
    printf "${c_primary}%-40s %-15s %-25s %s${c_reset}\n" "Path" "Branch" "Status" "Changes"
    echo

    # 遍历所有 worktree
    git worktree list | while read -r line; do
      # 提取路径
      local path=$(echo "$line" | awk '{print $1}')
      
      # 提取分支名称
      local branch=$(echo "$line" | grep -oE '\[[^]]+\]' | tr -d '[]')

      # 缩短路径显示
      local short_path="$path"
      if [[ "$path" == "$ROOT_DIR" ]]; then
        short_path="."
      else
        # 相对于根目录显示
        short_path="${path#$ROOT_DIR/}"
      fi

      # 检查是否有未提交变更
      local change_str=""
      local has_changes=false
      if [[ -d "$path/.git" ]]; then
        # 检查工作目录状态
        local status_out=$(cd "$path" && git status --porcelain)
        if [[ -n "$status_out" ]]; then
          has_changes=true
          # Use awk to count - avoids arithmetic issues in bash
          local untracked=$(echo "$status_out" | awk '/^??/ {count++} END {print count+0}')
          local modified=$(echo "$status_out" | awk '/^ M/ {count++} END {print count+0}')
          if [[ $modified -gt 0 && $untracked -gt 0 ]]; then
            change_str="${c_warning}${modified}m/${untracked}u${c_reset}"
          elif [[ $modified -gt 0 ]]; then
            change_str="${c_warning}${modified}m${c_reset}"
          elif [[ $untracked -gt 0 ]]; then
            change_str="${c_warning}${untracked}u${c_reset}"
          fi
        fi
      fi

      # 计算相对于主分支的状态
      local plain_status=""
      if [[ -n "$branch" && "$branch" != "$main_branch" ]]; then
        local ahead=0
        local behind=0
        if git rev-parse --verify "$branch" >/dev/null 2>&1; then
          # 使用 three-dot 语法分别计算领先和落后
          behind=$(git rev-list --count "$branch..$main_branch")
          ahead=$(git rev-list --count "$main_branch..$branch")
        fi

        if [[ $ahead -eq 0 && $behind -eq 0 ]]; then
          plain_status="synced with $main_branch"
        elif [[ $ahead -gt 0 && $behind -eq 0 ]]; then
          if [[ $has_changes == true ]]; then
            plain_status="$ahead ahead, has uncommitted"
          else
            plain_status="$ahead ahead, ready to merge"
          fi
        elif [[ $behind -gt 0 && $ahead -eq 0 ]]; then
          plain_status="$behind behind $main_branch"
        else
          plain_status="$ahead ahead / $behind behind"
        fi
      else
        # main 分支也要检查是否有未提交变化
        if [[ $has_changes == true ]]; then
          plain_status="$main_branch, has uncommitted changes"
        else
          plain_status="$main_branch, clean"
        fi
      fi

      # 使用简单的方式：先打印固定宽度的文本，再打印变更
      printf "%-40s %-15s %-25s %s\n" "$short_path" "$branch" "$plain_status" "$change_str"
     done
   }

}

_ws_run() {
  for ws in "${workspaces[@]}"; do
    (
      run cd "$ws"
      run "$@"
    )
  done
}

ws() {
  pwd()  { _ws_run command pwd; }
  exec() { _ws_run command "$@"; }
}

_sub_run() {
  for submodule in "${submodules[@]}"; do
    (
      run cd "$submodule"
      run "$@"
    )
  done
}


sub() {
  pwd()     { _sub_run command pwd; }
  status()  { _sub_run git status; }
  exec()    { _sub_run command "$@"; }
}

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################
sync() {
  submodule() {
    run git submodule set-branch --branch main vendor/sha
    run git submodule update --init --recursive --remote
  }
  dao() {
    run npx tsx packages/dao-cli/src/dao/cli.ts sync
  }
  all() {
    submodule
    dao
  }
}

clean() {
  run rm -rf ./build
  run rm -rf ./dist
}

####################################################
# 构建与检查
####################################################

####################################################
# app entry script & _root cmd
####################################################

sha "$@"


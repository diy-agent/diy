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
  # 添加新的 worktree 开发分支
  add() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
      echo "${c_error}用法：./sha.sh worktree add <branch-name>${c_reset}" >&2
      echo "${c_warning}示例：./sha.sh worktree add dao-feature-auth${c_reset}" >&2
      return 1
    fi

    local worktree_path="$worktree_dir/$name"

    # 检查是否已存在
    if [[ -d "$worktree_path" ]]; then
      echo "${c_warning}Worktree 已存在：$worktree_path${c_reset}" >&2
      return 0
    fi

    # 创建 worktree 目录
    run mkdir -p "$worktree_path"

    # 创建新的 worktree 分支（基于 main）
    run git worktree add -b "$name" "$worktree_path" HEAD

    echo "${c_success}✓ Worktree 创建成功：$worktree_path${c_reset}"
    echo "${c_info}下一步：cd $worktree_path && 开始开发${c_reset}"
  }

  # 列出所有 worktree 状态
  list() {
    run git worktree list
  }

  # 移除 worktree
  remove() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
      echo "${c_error}用法：./sha.sh worktree remove <branch-name>${c_reset}"
      return 1
    fi

    local worktree_path="$worktree_dir/$name"

    if [[ ! -d "$worktree_path" ]]; then
      echo "${c_error}Worktree 不存在：$worktree_path${c_reset}"
      return 1
    fi

    # 删除 worktree
    run git worktree remove "$worktree_path"
    run rm -rf "$worktree_path"

    echo "${c_success}✓ Worktree 已清理：$name${c_reset}"
  }

  # 双向合并：将目标分支合并到当前所在分支
  merge() {
    local target_name="${1:-}"
    local squash="$2"
    if [[ -z "$target_name" ]]; then
      echo "${c_error}用法：./sha.sh worktree merge <target-branch> [--squash]${c_reset}" >&2
      echo "${c_info}  --squash: 压缩为单一提交合并（类似 GitHub Squash and merge）${c_reset}" >&2
      echo "${c_info}  目标分支 → 当前分支 （不管你在主仓库还是worktree）${c_reset}" >&2
      echo "${c_info}  示例：${c_reset}" >&2
      echo "${c_info}    在 main 分支: ./sha.sh worktree merge dao-feature-xxx  → 将 dao-feature-xxx 合并到 main${c_reset}" >&2
      echo "${c_info}    在 dao-feature-xxx: ./sha.sh worktree merge main  → 将 main 合并到 dao-feature-xxx${c_reset}" >&2
      return 1
    fi

    # 获取当前分支名称
    local current_branch=$(git rev-parse --abbrev-ref HEAD)
    local current_dir=$(pwd)

    # 判断目标分支类型：main 还是 worktree 分支
    local target_path
    if [[ "$target_name" == "main" || "$target_name" == "master" ]]; then
      # 目标是主分支，不需要 worktree 路径
      target_path="$ROOT_DIR"
    else
      target_path="$worktree_dir/$target_name"
      if [[ ! -d "$target_path" ]]; then
        echo "${c_error}Worktree 分支不存在：$target_path${c_reset}" >&2
        return 1
      fi
    fi

    # 如果目标是 worktree 分支，且我们正在合并到 main，并且不是 squash 合并，则自动清理
    local should_cleanup=false
    if [[ "$current_branch" == "main" && "$target_name" != "main" && "$squash" != "--squash" ]]; then
      should_cleanup=true
    fi

    # 1. 更新目标分支（获取最新代码）
    echo "${c_primary}步骤 1/3: 更新目标分支 $target_name...${c_reset}"
    (
      if [[ -d "$target_path" ]]; then
        cd "$target_path"
        # 只有 main/master 才从远程拉取，worktree 分支不需要
        if [[ "$target_name" == "main" || "$target_name" == "master" ]]; then
          run git pull origin "$target_name"
        fi
      fi
    )

    # 2. 合并目标分支到当前分支
    echo "${c_primary}步骤 2/3: 合并 $target_name → $current_branch...${c_reset}"
    if [[ "$squash" == "--squash" ]]; then
      echo "${c_info}使用 squash 合并（压缩为单一提交）...${c_reset}"
      run git merge --squash "$target_name" || {
        echo "${c_error}合并冲突，请手动解决：${c_reset}" >&2
        echo "${c_warning}  1. 手动编辑冲突文件解决冲突${c_reset}" >&2
        echo "${c_warning}  2. git add <resolved-files>${c_reset}" >&2
        echo "${c_warning}  3. git commit${c_reset}" >&2
        if [[ $should_cleanup == true ]]; then
          echo "${c_warning}  4. ./sha.sh worktree remove $target_name${c_reset}" >&2
        fi
        return 1
      }
      # squash merge 自动暂存了所有变更，需要提示用户提交
      echo "${c_info}冲突已解决，所有变更已暂存，请执行提交：${c_reset}"
      echo "${c_dim}   git commit -m \"merge: $target_name into $current_branch\"${c_reset}"
    else
      run git merge "$target_name" -m "merge: $target_name into $current_branch" || {
        echo "${c_error}合并冲突，请手动解决：${c_reset}" >&2
        echo "${c_warning}  1. 手动编辑冲突文件解决冲突${c_reset}" >&2
        echo "${c_warning}  2. git add <resolved-files>${c_reset}" >&2
        echo "${c_warning}  3. git commit${c_reset}" >&2
        if [[ $should_cleanup == true ]]; then
          echo "${c_warning}  4. ./sha.sh worktree remove $target_name${c_reset}" >&2
        fi
        return 1
      }

      # 3. 自动清理：只有当从 worktree 分支合并到 main 且非 squash 合并成功才清理
      if [[ $should_cleanup == true ]]; then
        echo "${c_primary}步骤 3/3: 清理 worktree $target_name...${c_reset}"
        local target_worktree_path="$worktree_dir/$target_name"
        run git worktree remove "$target_worktree_path" 2>/dev/null || run rm -rf "$target_worktree_path"
        # 删除分支
        run git branch -D "$target_name"

        echo "${c_success}✓ 合并完成：$target_name → $current_branch${c_reset}"
        echo "${c_info}推送变更：git push origin $current_branch${c_reset}"
      else
        echo "${c_success}✓ 合并完成：$target_name → $current_branch${c_reset}"
      fi
    fi
  }


  # 显示帮助
  help() {
    cat << EOF
${c_primary}Worktree 开发流程管理${c_reset}

用法：./sha.sh worktree <command> [args]

  命令:
   ${c_secondary}add <name>${c_reset}         创建新的 worktree 分支到 $worktree_dir/<name>
   ${c_secondary}list${c_reset}               查看所有 worktree 状态
   ${c_secondary}merge <target> [--squash]${c_reset}
                          双向合并: <target> → 当前所在分支
                          target 可以是 main 或任意 worktree 分支名称
                          --squash: 压缩为单一提交 (类似 GitHub Squash and merge)
                          自动清理: worktree → main (非squash) 合并成功自动清理
   ${c_secondary}to_main <name> [--squash]${c_reset}
                          (兼容) 合并 worktree 到 main 并清理
   ${c_secondary}from_main [name]${c_reset}
                          (兼容) 合并 main 最新修改到 worktree 开发分支
                          在 .worktree/xxx 下可省略参数自动检测
   ${c_secondary}remove <name>${c_reset}      清理已合并的 worktree (不合并)
   ${c_secondary}help${c_reset}               显示此帮助信息

  示例:
    ./sha.sh worktree add dao-feature-auth     # 创建新特性分支
    cd .worktree/dao-feature-auth             # 进入开发
    # ... 主线有更新，同步主线改动 ...
    ./sha.sh worktree merge main              # 合并 main 最新修改到当前开发分支
    # 或者简写（兼容）: ./sha.sh worktree from_main
    # ... 开发、测试、提交 ...
    cd ../../../                               # 返回主仓库 main 分支
    ./sha.sh worktree merge dao-feature-auth  # 将开发分支合并到 main

流程说明:
  1. 主分支 (main) 保持稳定，不直接修改
  2. 新功能在 .worktree/dao-xxxx 独立开发
  3. 开发完成后通过 worktree merge 合并回 main
  4. 合并前自动运行测试验证

EOF
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


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

# 获取主分支名称（main 或 master）
_get_main_branch() {
  local main_branch="main"
  if ! git show-ref --verify --quiet "refs/heads/main"; then
    if git show-ref --verify --quiet "refs/heads/master"; then
      main_branch="master"
    fi
  fi
  echo "$main_branch"
}

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

  # 创建新 worktree
  add() {
    if [ $# -ne 1 ]; then
      echo "${c_error}Usage: ./sha.sh worktree add <branch-name>${c_reset}"
      exit 1
    fi
    local branch="$1"
    local main_branch=$(_get_main_branch)

    # Ensure worktree directory exists
    mkdir -p "$worktree_dir"

    local worktree_path="$worktree_dir/$branch"
    if [ -d "$worktree_path" ]; then
      echo "${c_error}Worktree already exists at $worktree_path${c_reset}"
      exit 1
    fi

    echo "${c_info}Creating new worktree for branch $branch from $main_branch...${c_reset}"
    run git worktree add -b "$branch" "$worktree_path" "$main_branch"

    echo
    echo "${c_success}Created worktree at: $worktree_path${c_reset}"
    echo "${c_success}Branch: $branch${c_reset}"
    echo
    echo "To start working:"
    echo "  cd $worktree_path"
  }

  # 列出所有 worktree 状态
  list() {
    local main_branch=$(_get_main_branch)

    # 使用进程替换，避免子shell变量丢失问题
    local json="["
    local first=true

    while read -r line; do
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
            change_str="${modified}m/${untracked}u"
          elif [[ $modified -gt 0 ]]; then
            change_str="${modified}m"
          elif [[ $untracked -gt 0 ]]; then
            change_str="${untracked}u"
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

      # 输出JSON行
      if [ "$first" = true ]; then
        first=false
      else
        json="$json,"
      fi
      json="$json{\"path\":\"$short_path\",\"branch\":\"$branch\",\"status\":\"$plain_status\",\"changes\":\"$change_str\"}"
    done < <(git worktree list)

    json="$json]"

    # 使用jq格式化为表格，然后column自动对齐
    printf "${c_primary}"
    echo "$json" | jq -r '
      ["Path", "Branch", "Status", "Changes"],
      ["----", "------", "------", "-------"],
      (.[] | [.path, .branch, .status, .changes])
      | @tsv
    ' | column -t -s $'\t'
    printf "${c_reset}"
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
  nodejs() {
    npm i --workspaces
  }
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
    nodejs
  }
}

clean() {
  run rm -rf ./build
  run rm -rf ./dist
}

####################################################################################
# GitHub Project 工作流命令 - 任务管理集成
####################################################################################
# GitHub Project 配置:
#   Owner: chen56
#   Project: dao (number 13)
#   Project ID: PVT_kwHOAB8fvs4BTGD4
#   Repository: whonb/dao
####################################################################################
GH_OWNER="chen56"
GH_PROJECT_NUM="13"
GH_PROJECT_ID="PVT_kwHOAB8fvs4BTGD4"
GH_REPO="whonb/dao"
work() {

  # 创建新工作任务
  # Usage: ./sha.sh work new "<issue-description>"
  new() {
    if [ $# -lt 1 ]; then
      echo "${c_error}error: Usage: ./sha.sh work new \"<issue-description>\"${c_reset}"
      exit 1
    fi
    local description="$*"

    # 检查变量 (防止空参数导致错误)
    if [ -z "$GH_PROJECT_NUM" ] || [ -z "$GH_OWNER" ] || [ -z "$GH_REPO" ]; then
      echo "${c_error}error: Configuration error: missing project configuration${c_reset}"
      exit 1
    fi

    # gh issue create --project expects project *title*, not number - so create first then add
    local output
    output=$(run gh issue create --repo "$GH_REPO" --title "$description" --body "$description")

    if [ $? -ne 0 ]; then
      echo "${c_error}error: Failed to create issue${c_reset}"
      exit 1
    fi

    # 提取 issue 编号
    local issue_url="$output"
    local issue_num=$(echo "$issue_url" | grep -oE '[0-9]+$')

    # 添加 issue 到 project - gh uses --url with full issue URL
    local issue_url="https://github.com/$GH_REPO/issues/$issue_num"
    run gh project item-add --owner "$GH_OWNER" "$GH_PROJECT_NUM" --url "$issue_url"

    echo
    echo "${c_success}success: Created issue #$issue_num: $issue_url${c_reset}"
    echo "${c_success}success: Added to project $GH_PROJECT_NUM (Status: Backlog)${c_reset}"
    echo
    echo "To start working:"
    echo "  ./sha.sh work start $issue_num"
  }

  # 开始任务 - 移动到 In Progress 并创建 worktree
  # Usage: ./sha.sh work start <issue-number> [branch-name]
  start() {
    if [ $# -lt 1 ] || [ $# -gt 2 ]; then
      echo "${c_error}Usage: ./sha.sh work start <issue-number> [branch-name]${c_reset}"
      exit 1
    fi
    local issue_num="$1"
    local branch_name
    if [ $# -eq 2 ]; then
      branch_name="$2"
    else
      branch_name="issue-$issue_num"
    fi
    local main_branch=$(_get_main_branch)

    # 获取 item ID 并更新状态
    local item_id
    item_id=$(run gh project item-list "$GH_PROJECT_NUM" --owner "$GH_OWNER" --format json | \
      jq -r '.items[] | select(.content.number == '"$issue_num"') | .id')

    if [ -z "$item_id" ] || [ "$item_id" = "null" ]; then
      echo "${c_error}error: Could not find issue #$issue_num in project $GH_PROJECT_NUM${c_reset}"
      exit 1
    fi

    run _gh_edit_item_feild_single_select "$GH_PROJECT_NUM" "$item_id" "Status" "In progress"

    echo "${c_success}success: Moved issue #$issue_num to In progress${c_reset}"
    echo

    # Ensure worktree directory exists
    mkdir -p "$worktree_dir"

    # 创建 worktree
    local worktree_path="$worktree_dir/$branch_name"
    if [ -d "$worktree_path" ]; then
      echo "${c_success}success: Worktree already exists at $worktree_path${c_reset}"
      exit 0
    fi

    run git worktree add -b "$branch_name" "$worktree_path" "$main_branch"

    echo
    echo "${c_success}success: Created worktree at: $worktree_path${c_reset}"
    echo "${c_success}success: Branch: $branch_name${c_reset}"
    echo
    echo "To start working:"
    echo "  cd $worktree_path and dev"
  }

  # 列出所有未完成任务
  # Usage: ./sha.sh work list
  list() {
    echo "${c_primary}Listing all incomplete tasks in project $GH_PROJECT_NUM${c_reset}"
    echo

    # 使用 gh project item-list 获取所有 items，然后过滤掉 Done 状态
    echo "${c_info}Fetching project items...${c_reset}"
    echo

    # Get data output all at once
    local lines=$(run gh project item-list "$GH_PROJECT_NUM" --owner "$GH_OWNER" --format json)

    if [ $? -ne 0 ]; then
      return $?
    fi

    # 使用jq格式化为表格，然后column自动对齐
    printf "${c_primary}"
    echo "$lines" | jq -r '
      (["Issue", "Status", "Prio", "Repository", "Module", "Title"] | @tsv),
      (["-----", "------", "----", "------", "------", "-----"] | @tsv),
      ((if type == "object" and .items then .items else . end)[]
       | select(.status != "Done")
       | select(.content != null)
       | ["#\(.content.number)", .status, .priority // "-", .content.repository // "-",  .module // "-", .content.title]
       | @tsv)
    ' | column -t -s $'\t'
    printf "${c_reset}"
  }

}


# 用法: _gh_edit_item_feild_single_select <PROJECT_NUMBER> <ITEM_ID> <FIELD_NAME> <OPTION_NAME>
# 现在的调用方式就变“人类”了：
#   _gh_edit_item_feild_single_select 5 "PVTI_lAHOAB..." "Status" "In Progress"
_gh_edit_item_feild_single_select() {
  local proj_num=$1
  local item_id=$2
  local field_name=$3
  local option_name=$4

  # 1. 自动获取 Field ID
  local field_id=$(run gh project field-list $proj_num --owner "$GH_OWNER" --format json | \
    jq -r ".fields[] | select(.name == \"$field_name\") | .id")

  # 2. 自动获取 Option ID
  local option_id=$(run gh project field-list $proj_num --owner "$GH_OWNER" --format json | \
    jq -r ".fields[] | select(.name == \"$field_name\") | .options[] | select(.name == \"$option_name\") | .id")

  # 3. 执行修改 - item-edit needs the full project ID (PVT_*) not the project number
  run gh project item-edit --id "$item_id" --project-id "$GH_PROJECT_ID" --field-id "$field_id" --single-select-option-id "$option_id"
}



####################################################
# 构建与检查
####################################################

####################################################
# app entry script & _root cmd
####################################################

sha "$@"


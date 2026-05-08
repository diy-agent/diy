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
source "./sha_common.sh"


####################################################################################
# GitHub Project 工作流配置
####################################################################################
GH_OWNER="chen56"
GH_PROJECT_NUM="13"
GH_PROJECT_ID="PVT_kwHOAB8fvs4BTGD4"
GH_REPO="xx-agent/xx"

# 获取当前 GitHub 用户名
_get_gh_user() {
  gh api user -q .login
}

# 全局命令不要进入到_c目录
# cd "$ROOT_DIR"

_workspaces=(packages/*/)
_submodules=(vendor/*/)
_worktree_dir=".worktree"

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
# dev 工作流
####################################################################################
# 使用示例:
#   ./sha.sh dev list                    # 查看所有 worktree 状态
####################################################################################
dev() {

  # 列出所有 worktree 状态   
  list() {
    local main_branch=$(_get_main_branch)

    # First pass: collect all worktree info and extract issue numbers
    local -a worktrees=()
    local -a issue_nums=()
    local -a branches=()

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

      # 检查路径是否存在，如果不存在标记为 prunable
      if [[ ! -d "$path" ]]; then
        short_path="$short_path **prunable**"
      fi

      # 检查是否有未提交变更（只需知道是否有变更，用于添加*）
      local has_changes=false
      if [[ -e "$path/.git" ]]; then
        local status_out=$(cd "$path" && git status --porcelain)
        if [[ -n "$status_out" ]]; then
          has_changes=true
        fi
      fi

      # 合并分支名称+状态：Branch* + arrows for ahead/behind
      local branch_display="$branch"
      # Add * for uncommitted changes
      if [[ $has_changes == true ]]; then
        branch_display="$branch_display*"
      fi
      # Calculate ahead - only for non-main branches
      local ahead=0
      local behind=0
      if [[ -n "$branch" && "$branch" != "$main_branch" ]]; then
        if git rev-parse --verify "$branch" >/dev/null 2>&1; then
          # 使用 three-dot 语法分别计算领先和落后
          behind=$(git rev-list --count "$branch..$main_branch")
          ahead=$(git rev-list --count "$main_branch..$branch")
        fi
      fi

      # Extract issue number from branch:
      # - 8-feat-name (new format)
      # - issue-8 (old format for backward compatibility)
      # - 8 (just the issue number)
      local issue_num=""
      if [[ "$branch" =~ ^([0-9]+)- ]]; then
        issue_num="${BASH_REMATCH[1]}"
        issue_nums+=("$issue_num")
        branches+=("$branch")
      elif [[ "$branch" =~ ^issue-([0-9]+)$ ]]; then
        issue_num="${BASH_REMATCH[1]}"
        issue_nums+=("$issue_num")
        branches+=("$branch")
      elif [[ "$branch" =~ ^[0-9]+$ ]]; then
        issue_num="$branch"
        issue_nums+=("$issue_num")
        branches+=("$branch")
      fi

      # Store worktree data for second pass
      worktrees+=("$short_path|$branch_display|$issue_num|$branch|$ahead")
    done < <(git worktree list)

    # If we found issue branches, fetch all issue titles in one API call
    # Use temp file for mapping since bash 3.2 doesn't support associative arrays
    local issue_map_file
    issue_map_file=$(mktemp)
    # Temp file for PR info
    local pr_map_file
    pr_map_file=$(mktemp)
    
    if [[ ${#issue_nums[@]} -gt 0 ]]; then
      # Fetch all project items once - reuse the same pattern as issue list
      local project_data
      project_data=$(run gh project item-list "$GH_PROJECT_NUM" --owner "$GH_OWNER" --format json)
      if [[ $? -eq 0 ]]; then
        # Extract all issue numbers, status, and titles into temp file
        echo "$project_data" | jq -r '
          ((if type == "object" and .items then .items else . end)[]
           | select(.content != null)
           | select(.content.number != null)
           | "\(.content.number)\t\(.status // "-")\t\(.content.title)")
        ' > "$issue_map_file"
      fi
    fi
    
    # Fetch PR info for all branches with issue numbers
    if [[ ${#branches[@]} -gt 0 ]]; then
      # Fetch all PRs in one go
      local pr_data
      pr_data=$(run gh pr list --repo "$GH_REPO" --state all --json number,headRefName,state,url)
      if [[ $? -eq 0 ]]; then
        # Extract PR info mapped by branch name
        echo "$pr_data" | jq -r '
          .[] | "\(.headRefName)\t\(.number)\t\(.state)\t\(.url)"
        ' > "$pr_map_file"
      fi
    fi

    # Second pass: build JSON with issue information
    local json="["
    local first=true
    for wt in "${worktrees[@]}"; do
      IFS='|' read -r short_path branch_display issue_num branch ahead <<< "$wt"
      local issue_status="-"
      local issue_title=""
      if [[ -n "$issue_num" && -s "$issue_map_file" ]]; then
        # Lookup issue status and title from temp file
        issue_status=$(grep "^$issue_num"$'\t' "$issue_map_file" | cut -f2)
        issue_title=$(grep "^$issue_num"$'\t' "$issue_map_file" | cut -f3)
      fi
      
      # PR information
      local pr_num="-"
      local pr_state="-"
      local pr_url="-"
      if [[ -n "$branch" && -s "$pr_map_file" ]]; then
        # Lookup PR info by branch name
        # Use || true to avoid error when grep finds nothing
        local pr_line=$(grep "^$branch"$'\t' "$pr_map_file" | head -1 || true)
        if [[ -n "$pr_line" ]]; then
          pr_num=$(echo "$pr_line" | cut -f2)
          pr_state=$(echo "$pr_line" | cut -f3)
          pr_url=$(echo "$pr_line" | cut -f4)
        fi
      fi

      # 处理内容中的特殊字符，替换掉换行符
      issue_title="${issue_title//$'\n'/ }"
      
      if [ "$first" = true ]; then
        first=false
      else
        json="$json,"
      fi
      json="$json{\"path\":\"$short_path\",\"branch_display\":\"$branch_display\",\"ahead\":$ahead,\"issue_num\":\"$issue_num\",\"issue_status\":\"$issue_status\",\"pr_num\":\"$pr_num\",\"pr_state\":\"$pr_state\",\"issue_title\":\"$issue_title\"}"
    done

    # Cleanup temp files
    rm -f "$issue_map_file"
    rm -f "$pr_map_file"

    json="$json]"

    # 先输出标题
    printf "${primary}%-20s %-18s %-8s %-6s %-12s %s${reset}\n" "Path" "Branch" "Ahead" "PR" "PR State" "Project Status"
    printf "${primary}%-20s %-18s %-8s %-6s %-12s %s${reset}\n" "----" "------" "-----" "--" "--------" "--------------"
    
    # 逐行处理并上色
    echo "$json" | jq -c '.[]' | while read -r item; do
      local path=$(echo "$item" | jq -r '.path')
      local branch_display=$(echo "$item" | jq -r '.branch_display')
      local ahead=$(echo "$item" | jq -r '.ahead')
      local pr_num=$(echo "$item" | jq -r '.pr_num')
      local pr_state=$(echo "$item" | jq -r '.pr_state')
      local issue_status=$(echo "$item" | jq -r '.issue_status')
      
      # 格式化PR
      local pr="$pr_num"
      if [[ "$pr_num" != "-" ]]; then
        pr="#$pr_num"
      fi
      
       # 特殊处理颜色，保证对齐（转义字符不占可见宽度）
      local ahead_start=""
      local ahead_end=""
      if [[ "$ahead" -gt 0 ]]; then
        ahead_start="$warning"
        ahead_end="$reset"
      fi
      
      local pr_start=""
      local pr_end=""
      if [[ "$pr_state" == "OPEN" ]]; then
        pr_start="$warning"
        pr_end="$reset"
      fi
      
      printf "%-20s %-18s ${ahead_start}%-8d${ahead_end} %-6s ${pr_start}%-12s${pr_end} %s\n" "$path" "$branch_display" "$ahead" "$pr" "$pr_state" "$issue_status"
    done
  }

  # 提交 PR
  # Usage: ./sha.sh dev pr
  pr() {
    local branch=$(git branch --show-current)
    local main_branch=$(_get_main_branch)

    if [[ "$branch" == "$main_branch" ]]; then
      echo "${error}error: Cannot create PR from main branch${reset}"
      exit 1
    fi

    # Extract issue number from branch name
    local issue_num=""
    if [[ "$branch" =~ ^([0-9]+)- ]]; then
      issue_num="${BASH_REMATCH[1]}"
    elif [[ "$branch" =~ ^issue-([0-9]+)$ ]]; then
      issue_num="${BASH_REMATCH[1]}"
    elif [[ "$branch" =~ ^[0-9]+$ ]]; then
      issue_num="$branch"
    fi

    if [[ -z "$issue_num" ]]; then
       echo "${error}error: Could not determine issue number from branch '$branch'${reset}"
       exit 1
    fi

    # Check for uncommitted changes
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "${error}warning: You have uncommitted changes. Please commit them before creating a PR.${reset}"
      # exit 1
    fi

    echo "${info}Get PR issue #$issue_num...${reset}"

    # Get issue title from GitHub
    local issue_title
    issue_title=$(run gh issue view "$issue_num" --repo "$GH_REPO" --json title -q .title)
    if [[ -z "$issue_title" ]]; then
       echo "${error}error: Issue '$issue_num' not found ${reset}"
       exit 1
    fi

    # Push current branch
    run git push origin "$branch"
    local gh_user=$(_get_gh_user)
    if [[ -z "$gh_user" ]]; then
       echo "${error}error: Could not determine GitHub username. Please run 'gh auth login'${reset}"
       exit 1
    fi

     # Check if open PR already exists (only check open PRs, allow new PR if existing is merged/closed)
     local existing_pr
     existing_pr=$(run gh pr list --repo "$GH_REPO" --head "$branch" --state open --json number -q ".[0].number")
     if [[ -n "$existing_pr" ]]; then
        echo "${success}success: Open PR #$existing_pr already exists${reset}"
     else
        run gh pr create --repo "$GH_REPO" --base "$main_branch" --head "$branch" --title "$issue_title" --body "Complete #$issue_num"
     fi

    # project workflow auto Update Project Status to "In review"
    # https://github.com/users/chen56/projects/13/workflows/86523095
  }

  # 显示当前状态 - issue信息、PR信息、Git信息
  # Usage: ./sha.sh dev status
  status() {
    local branch=$(git branch --show-current)
    local main_branch=$(_get_main_branch)
    local repo_root=$(git rev-parse --show-toplevel)

    # Extract issue number from branch name
    local issue_num=""
    if [[ "$branch" =~ ^([0-9]+)- ]]; then
      issue_num="${BASH_REMATCH[1]}"
    elif [[ "$branch" =~ ^issue-([0-9]+)$ ]]; then
      issue_num="${BASH_REMATCH[1]}"
    elif [[ "$branch" =~ ^[0-9]+$ ]]; then
      issue_num="$branch"
    fi

    echo "${primary}=== Git Information ===${reset}"
    echo "  Branch:         $branch"
    echo "  Base branch:    $main_branch"
    echo "  Repository:     $GH_REPO"
    echo "  Root directory: $repo_root"

     # Check uncommitted changes
     local has_changes=false
     local status_out=$(git status --porcelain)
     if [[ -n "$status_out" ]]; then
       has_changes=true
       local change_count=$(echo "$status_out" | wc -l)
       echo "  Changes:        ${warning}$change_count uncommitted file(s)${reset}"
     else
       echo "  Changes:        Clean working directory"
     fi

     # Ahead/behind tracking
     local ahead=0
     local behind=0
     if [[ "$branch" != "$main_branch" ]]; then
       if git rev-parse --verify "$main_branch" >/dev/null 2>&1 && git rev-parse --verify "$branch@{upstream}" >/dev/null 2>&1; then
         ahead=$(git rev-list --count "$main_branch..$branch")
         behind=$(git rev-list --count "$branch@{upstream}..$main_branch")
         if [[ "$ahead" -gt 0 ]]; then
           echo "  Tracking:       ${warning}↑$ahead ahead, ↓$behind behind $main_branch${reset}"
         else
           echo "  Tracking:       ↑$ahead ahead, ↓$behind behind $main_branch"
         fi
       fi
     fi

    if [[ -z "$issue_num" ]]; then
      echo
      echo "${warning}No issue number found in branch name '$branch'${reset}"
      return 0
    fi

    echo
    echo "${primary}=== Issue Information ===${reset}"
    echo "  Issue #:        #$issue_num"

    # Get issue information from GitHub
    local issue_info
    issue_info=$(run gh issue view "$issue_num" --repo "$GH_REPO" --json number,title,state,url,labels,assignees,author 2>/dev/null)
    if [[ $? -eq 0 && -n "$issue_info" ]]; then
      local title=$(echo "$issue_info" | jq -r '.title')
      local state=$(echo "$issue_info" | jq -r '.state')
      local url=$(echo "$issue_info" | jq -r '.url')
      local author=$(echo "$issue_info" | jq -r '.author.login')
      local labels=$(echo "$issue_info" | jq -r '[.labels[].name] | join(", ")')

       echo "  Title:          $title"
       if [[ "$state" == "OPEN" ]]; then
         echo "  State:          ${warning}${state}${reset}"
       else
         echo "  State:          $state"
       fi
       echo "  Author:         $author"
       echo "  URL:            $url"
      if [[ -n "$labels" && "$labels" != "[]" && "$labels" != "" ]]; then
        echo "  Labels:         $labels"
      fi
    else
      echo "${warning}  Could not fetch issue #$issue_num from GitHub${reset}"
    fi

    # Get project information
    echo
    echo "${primary}=== Project Information ===${reset}"
    local project_info
    project_info=$(run gh project item-list "$GH_PROJECT_NUM" --owner "$GH_OWNER" --format json 2>/dev/null)
    if [[ $? -eq 0 && -n "$project_info" ]]; then
       local status=$(echo "$project_info" | jq -r "(if type == \"object\" and .items then .items else . end)[] | select(.content != null and .content.number == $issue_num) | .status // \"-\"")
       local priority=$(echo "$project_info" | jq -r "(if type == \"object\" and .items then .items else . end)[] | select(.content != null and .content.number == $issue_num) | .priority // \"-\"")
       local module=$(echo "$project_info" | jq -r "(if type == \"object\" and .items then .items else . end)[] | select(.content != null and .content.number == $issue_num) | .module // \"-\"")

       # 进行中的状态加warning颜色
       if [[ "$status" =~ ^(In progress|In review)$ ]]; then
         echo "  Status:         ${warning}$status${reset}"
       else
         echo "  Status:         $status"
       fi
       echo "  Priority:       $priority"
       echo "  Module:         $module"
    fi

    echo
    echo "${primary}=== Pull Request Information ===${reset}"

    # Check if PR exists for current branch
    local pr_info
    pr_info=$(run gh pr list --repo "$GH_REPO" --head "$branch" --json number,title,state,url,mergeable 2>/dev/null)
    if [[ $? -eq 0 && -n "$pr_info" ]]; then
      local pr_count=$(echo "$pr_info" | jq -r 'length')
      if [[ "$pr_count" -gt 0 ]]; then
        local first_pr=$(echo "$pr_info" | jq -r '.[0]')
        local pr_num=$(echo "$first_pr" | jq -r '.number')
        local pr_title=$(echo "$first_pr" | jq -r '.title')
        local pr_state=$(echo "$first_pr" | jq -r '.state')
        local pr_url=$(echo "$first_pr" | jq -r '.url')
        local mergeable=$(echo "$first_pr" | jq -r '.mergeable')

         echo "  PR #:            #$pr_num"
         echo "  Title:          $pr_title"
         if [[ "$pr_state" == "OPEN" ]]; then
           echo "  State:          ${warning}${pr_state}${reset}"
         else
           echo "  State:          $pr_state"
         fi
         echo "  Mergeable:      $mergeable"
         echo "  URL:            $pr_url"
      else
        echo "  No open PR found for branch '$branch'"
      fi
    else
      echo "  Could not fetch PR information from GitHub"
    fi

    echo
  }
}

_ws_run() {
  for ws in "${_workspaces[@]}"; do
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
  for submodule in "${_submodules[@]}"; do
    (
      cd "$submodule"
      run "$@"
    )
  done
}


submodule() {
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
    # run git submodule set-branch --branch main vendor/sha
    run git submodule update --init --recursive --remote
  }
  xx() {
    run npx tsx packages/xx-cli/src/xx/cli.ts sync
  }
  all() {
    submodule
    xx
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
# ref: `docs/dev-flow.md`
# GitHub Project 配置:
#   Owner: chen56
#   Project: xx (number 13)
#   Project ID: PVT_kwHOAB8fvs4BTGD4
#   Repository: xx-agent/xx
####################################################################################
issue() {

  # 创建新工作任务
  # Usage: ./sha.sh work new "<issue-description>"
  new() {
    if [ $# -lt 1 ]; then
      echo "${error}error: Usage: ./sha.sh work new \"<issue-description>\"${reset}"
      exit 1
    fi
    local description="$*"

    # 检查变量 (防止空参数导致错误)
    if [ -z "$GH_PROJECT_NUM" ] || [ -z "$GH_OWNER" ] || [ -z "$GH_REPO" ]; then
      echo "${error}error: Configuration error: missing project configuration${reset}"
      exit 1
    fi

    # gh issue create --project expects project *title*, not number - so create first then add
    local output
    output=$(run gh issue create --repo "$GH_REPO" --title "$description" --body "$description")

    if [ $? -ne 0 ]; then
      echo "${error}error: Failed to create issue${reset}"
      exit 1
    fi

    # 提取 issue 编号
    local issue_url="$output"
    local issue_num=$(echo "$issue_url" | grep -oE '[0-9]+$')

    # 添加 issue 到 project - gh uses --url with full issue URL
    local issue_url="https://github.com/$GH_REPO/issues/$issue_num"
    run gh project item-add --owner "$GH_OWNER" "$GH_PROJECT_NUM" --url "$issue_url"

    echo
    echo "${success}success: Created issue #$issue_num: $issue_url${reset}"
    echo "${success}success: Added to project $GH_PROJECT_NUM (Status: Backlog)${reset}"
    echo
    echo "To start dev:"
    echo "  ./sha.sh issue dev $issue_num"
  }

  # 开始任务 - 移动到 In Progress 并创建 worktree
  # Usage: ./sha.sh work dev <issue-number> [branch-name]
  dev() {
    if [ $# -lt 1 ] || [ $# -gt 2 ]; then
      echo "${error}Usage: ./sha.sh issue dev <issue-number> [branch-name]${reset}"
      exit 1
    fi
    local issue_num="$1"
    local branch_name
    if [ $# -eq 2 ]; then
      branch_name="$issue_num-$2"
    else
      branch_name="$issue_num"
    fi
    local main_branch=$(_get_main_branch)

    # 获取 item ID 并更新状态
    run _gh_edit_item_field_single_select "$GH_PROJECT_NUM" "$issue_num" "Status" "In progress"

    echo "${success}success: Moved issue #$issue_num to In progress${reset}"
    echo

    # Ensure worktree directory exists
    mkdir -p "$_worktree_dir"

    # 创建 worktree
    local worktree_path="$_worktree_dir/$branch_name"
    if [ -d "$worktree_path" ]; then
      echo "${success}success: Worktree already exists at $worktree_path${reset}"
      exit 0
    fi

    run git worktree add -b "$branch_name" "$worktree_path" "$main_branch"
    run git push -u origin "$branch_name"

    echo
    echo "${success}success: Created worktree at: $worktree_path${reset}"
    echo "${success}success: Branch: $branch_name${reset}"
    echo
    echo "To start dev:"
    echo "  cd $worktree_path and dev"
  }

  # 列出所有未完成任务
  # Usage: ./sha.sh work list
  list() {
    echo "${primary}Listing all incomplete tasks in project $GH_PROJECT_NUM${reset}"
    echo

    # 使用 gh project item-list 获取所有 items，然后过滤掉 Done 状态
    echo "${info}Fetching project items...${reset}"
    echo

    # Get data output all at once
    local lines=$(run gh project item-list "$GH_PROJECT_NUM" --owner "$GH_OWNER" --format json)

    if [ $? -ne 0 ]; then
      return $?
    fi

    # 使用jq格式化为表格，然后column自动对齐
    printf "${primary}"
    echo "$lines" | jq -r '
      (["Issue", "Status", "Prio", "Repository", "Module", "Title"] | @tsv),
      (["-----", "------", "----", "------", "------", "-----"] | @tsv),
      ((if type == "object" and .items then .items else . end)[]
       | select(.status == "Ready" or .status == "In progress" or .status == "In review")
       | select(.content != null)
       | ["#\(.content.number)", .status, .priority // "-", .content.repository // "-",  .module // "-", .content.title]
       | @tsv)
    ' | column -t -s $'\t'
    printf "${reset}"
  }

}


# 用法: _gh_edit_item_field_single_select <PROJECT_NUMBER> <ISSUE_NUMBER> <FIELD_NAME> <OPTION_NAME>
# 现在的调用方式就变“人类”了：
#   _gh_edit_item_field_single_select 5 "42" "Status" "In Progress"
_gh_edit_item_field_single_select() {
  local proj_num=$1
  local issue_num=$2
  local field_name=$3
  local option_name=$4

  # 0. 自动获取 Item ID
  local item_id
  item_id=$(run gh project item-list "$proj_num" --owner "$GH_OWNER" --format json | \
    jq -r "(if type == \"object\" and .items then .items else . end)[] | select(.content.number == $issue_num) | .id")

  if [ -z "$item_id" ] || [ "$item_id" = "null" ]; then
    echo "${error}error: Could not find issue #$issue_num in project $proj_num${reset}"
    return 1
  fi

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


#!/bin/bash
# release-please-doctor — 诊断 release-please 版本发布流程的正确性
# 用法: bash scripts/release-please-doctor.sh [-v]
#   -v  详细模式，显示 dry-run 完整输出
#
# 完全只读，绝不创建分支/PR/tag，可安全用于 CI / 本地诊断

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERBOSE=false
if [[ "${1:-}" == "-v" ]]; then
  VERBOSE=true
fi

PASS=0
FAIL=0
WARN=0

pass()  { PASS=$((PASS+1)); printf "  ✓ %s\n" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf "  ✗ %s\n" "$1"; }
warn()  { WARN=$((WARN+1)); printf "  ⚠ %s\n" "$1"; }
info()  { printf "    %s\n" "$1"; }

header() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

section() {
  echo ""
  echo "── $1 ──"
}

# 从文件中提取版本号（兼容 macOS BSD sed）
extract_version() {
  local v
  v=$(sed -n 's/.*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1)
  if [[ -z "$v" ]]; then
    v=$(sed -n 's/.*__version__[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1)
  fi
  echo "$v"
}

echo "release-please doctor"
echo "运行时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "仓库: $(git remote get-url origin)"

# ================================================================
# 1. 前置检查：工具链
# ================================================================
header "1. 工具链检查"

if command -v node_modules/.bin/release-please &>/dev/null; then
  pass "release-please 已安装 ($(node_modules/.bin/release-please --version 2>&1 | head -1))"
else
  fail "release-please 未安装，请运行 npm install"
fi

if command -v gh &>/dev/null; then
  if gh auth status &>/dev/null 2>&1; then
    pass "gh CLI 已登录 ($(gh auth status 2>&1 | head -1))"
  else
    fail "gh CLI 已安装但未登录"
  fi
else
  fail "gh CLI 未安装"
fi

# ================================================================
# 2. 配置文件完整性
# ================================================================
header "2. 配置文件检查"

CONFIG_FILE=".release-please-config.json"
MANIFEST_FILE=".release-please-manifest.json"

if [[ -f "$CONFIG_FILE" ]]; then
  if jq empty "$CONFIG_FILE" 2>/dev/null; then
    pass "$CONFIG_FILE 存在且 JSON 合法"
  else
    fail "$CONFIG_FILE JSON 不合法"
  fi
else
  fail "$CONFIG_FILE 不存在"
fi

if [[ -f "$MANIFEST_FILE" ]]; then
  if jq empty "$MANIFEST_FILE" 2>/dev/null; then
    pass "$MANIFEST_FILE 存在且 JSON 合法"
  else
    fail "$MANIFEST_FILE 不存在"
  fi
fi

# 提取 repo-url（从 config 或 git remote）
REPO_URL=$(jq -r '.["repo-url"] // empty' "$CONFIG_FILE" 2>/dev/null || true)
if [[ -z "$REPO_URL" ]]; then
  REPO_URL=$(git remote get-url origin | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|')
fi

# ================================================================
# 3. 逐包检查：版本一致性、文件存在性、tag 状态
# ================================================================
header "3. 逐包检查"

# 从 config 动态发现所有包路径
PACKAGES=$(jq -r '.packages | keys[]' "$CONFIG_FILE" 2>/dev/null || true)

if [[ -z "$PACKAGES" ]]; then
  fail "config 中未配置任何 packages"
else
  while IFS= read -r pkg_path; do
    section "包: $pkg_path"

    # 3a. manifest 中有记录吗
    MANIFEST_VER=$(jq -r ".[\"$pkg_path\"] // empty" "$MANIFEST_FILE" 2>/dev/null)
    if [[ -n "$MANIFEST_VER" ]]; then
      pass "manifest 中已记录版本: $MANIFEST_VER"
    else
      fail "manifest 中未记录该包"
    fi

    # 3b. 包目录是否存在
    if [[ -d "$pkg_path" ]]; then
      pass "包目录存在: $pkg_path"
    else
      fail "包目录不存在: $pkg_path"
      continue
    fi

    # 3c. 收集该包所有需要版本一致的文件
    VERSION_FILES=()

    RELEASE_TYPE=$(jq -r ".packages[\"$pkg_path\"].\"release-type\" // \"\"" "$CONFIG_FILE")

    # Python 包默认版本文件
    if [[ "$RELEASE_TYPE" == "python" ]]; then
      if [[ -f "$pkg_path/pyproject.toml" ]]; then
        VERSION_FILES+=("$pkg_path/pyproject.toml")
      fi
      PKG_NAME=$(jq -r ".packages[\"$pkg_path\"].\"package-name\" // \"\"" "$CONFIG_FILE")
      for init_file in "$pkg_path/src/$PKG_NAME/__init__.py" "$pkg_path/$PKG_NAME/__init__.py"; do
        if [[ -f "$init_file" ]]; then
          VERSION_FILES+=("$init_file")
        fi
      done
    fi

    # extra-files（用户配置的额外文件）
    EXTRA_FILES=$(jq -r ".packages[\"$pkg_path\"].\"extra-files\" // [] | .[]" "$CONFIG_FILE" 2>/dev/null || true)
    while IFS= read -r ef; do
      [[ -z "$ef" ]] && continue
      if [[ -f "$ef" ]]; then
        VERSION_FILES+=("$ef")
      else
        warn "extra-file 不存在: $ef"
      fi
    done <<< "$EXTRA_FILES"

    # 检查版本一致性
    if [[ ${#VERSION_FILES[@]} -eq 0 ]]; then
      warn "未找到版本文件（非致命，但需确认 release-please 策略）"
    else
      for f in "${VERSION_FILES[@]}"; do
        v=$(extract_version "$f")
        if [[ -z "$v" ]]; then
          warn "$f: 无法提取版本号"
        elif [[ -n "${MANIFEST_VER:-}" && "$v" != "$MANIFEST_VER" ]]; then
          fail "$f ($v) ≠ manifest ($MANIFEST_VER)"
        else
          pass "$f: $v"
        fi
      done
    fi

    # 3d. tag 状态
    COMPONENT=$(jq -r ".packages[\"$pkg_path\"].component // \"\"" "$CONFIG_FILE")
    if [[ -n "${COMPONENT:-}" && -n "${MANIFEST_VER:-}" ]]; then
      tag_name="${COMPONENT}-v${MANIFEST_VER}"
      if git rev-parse "${tag_name}" &>/dev/null 2>&1; then
        pass "tag 存在: ${tag_name}"
      else
        warn "tag 不存在: ${tag_name}（首次发布或 tag 丢失，release-please 将从全量 commit 扫描）"
      fi
    fi

  done <<< "$PACKAGES"
fi

# ================================================================
# 4. workflow 运行状态诊断（release-please 两步机制）
# ================================================================
header "4. workflow 运行状态诊断"

WORKFLOW_FILE=".github/workflows/release-please.yml"

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  warn "workflow 文件不存在: $WORKFLOW_FILE（跳过远端运行状态检查）"
else
  echo ""
  info "release-please 采用两步发布机制："
  info "  ① push 触发 → 检测 conventional commits → 开 release PR"
  info "  ② 合并 PR → 打 tag + 创建 GitHub Release → releases_created=true → 触发 downstream job（如 PyPI 发布）"
  echo ""

  # 获取最近几次 workflow run
  RECENT_RUNS=$(gh run list --repo "$REPO_URL" --workflow="$WORKFLOW_FILE" --limit 5 --json databaseId,status,conclusion,createdAt,url 2>/dev/null || true)

  if [[ -z "$RECENT_RUNS" ]]; then
    warn "无法获取 workflow 运行记录（检查 gh CLI 权限或网络）"
  else
    RUN_COUNT=$(echo "$RECENT_RUNS" | jq 'length')
    info "最近 $RUN_COUNT 次 workflow 运行:"

    while IFS= read -r run; do
      run_id=$(echo "$run" | jq -r '.databaseId')
      conclusion=$(echo "$run" | jq -r '.conclusion')
      status=$(echo "$run" | jq -r '.status')
      created_at=$(echo "$run" | jq -r '.createdAt')
      run_url=$(echo "$run" | jq -r '.url')

      # 获取该 run 的 jobs
      JOBS=$(gh run view "$run_id" --repo "$REPO_URL" --json jobs 2>/dev/null | jq '.jobs' || echo "[]")

      # 找 release-please job 的结论和 releases_created 输出
      RP_JOB=$(echo "$JOBS" | jq 'map(select(.name == "release-please")) | first // {}')
      RP_CONCLUSION=$(echo "$RP_JOB" | jq -r '.conclusion // "unknown"')

      # 找 publish job
      PUB_JOB=$(echo "$JOBS" | jq 'map(select(.name | startswith("publish"))) | first // {}')
      PUB_CONCLUSION=$(echo "$PUB_JOB" | jq -r '.conclusion // "none"')
      PUB_NAME=$(echo "$PUB_JOB" | jq -r '.name // ""')

      # 区分状态
      if [[ "$RP_CONCLUSION" == "success" && "$PUB_CONCLUSION" == "skipped" ]]; then
        STATUS_ICON="🟡"
        STATUS_DESC="开了 PR 但未发布"
      elif [[ "$RP_CONCLUSION" == "success" && "$PUB_CONCLUSION" == "success" ]]; then
        STATUS_ICON="🟢"
        STATUS_DESC="发布成功"
      elif [[ "$RP_CONCLUSION" == "success" && "$PUB_CONCLUSION" == "failure" ]]; then
        STATUS_ICON="🔴"
        STATUS_DESC="发布失败"
      elif [[ "$conclusion" == "failure" ]]; then
        STATUS_ICON="🔴"
        STATUS_DESC="workflow 执行失败"
      else
        STATUS_ICON="⚪"
        STATUS_DESC="状态: $RP_CONCLUSION / $PUB_CONCLUSION"
      fi

      info "$STATUS_ICON Run #$run_id: $STATUS_DESC ($created_at)"
      info "   URL: $run_url"

      # 如果有 publish job 被 skip，查 release-please 日志找原因
      if [[ "$PUB_CONCLUSION" == "skipped" && "$RP_CONCLUSION" == "success" ]]; then
        RP_LOG=$(gh run view "$run_id" --log --repo "$REPO_URL" 2>/dev/null || true)

        # 检查是 "No commits" 还是 "Created PR"
        if echo "$RP_LOG" | grep -q "Successfully opened pull request"; then
          PR_NUM=$(echo "$RP_LOG" | grep "Successfully opened pull request:" | head -1 | sed 's/.*pull request: //' | tr -dc '0-9' | grep -o '^[0-9][0-9]*$' || true)
          if [[ -z "${PR_NUM:-}" ]]; then
            info "   → release-please 已创建 PR，等待合并后才会触发发布"
          else
            info "   → release-please 已创建 PR #${PR_NUM}，等待合并后才会触发发布"
            info "   → 合并 PR 步骤: gh pr merge ${PR_NUM} --repo $REPO_URL"
          fi
        elif echo "$RP_LOG" | grep -q "No commits for path"; then
          PKG_PATH=$(echo "$RP_LOG" | grep "No commits for path" | sed 's/.*path: \([^,]*\).*/\1/')
          info "   → 没有新的 conventional commits 在路径 $PKG_PATH 下"
          info "   → 如需发版，确保 commit 以 feat: 或 fix: 开头，且文件在包路径内"
        elif echo "$RP_LOG" | grep -q "Considering: 0 commits"; then
          info "   → 检测到 0 个 conventional commits（变更不匹配包路径，或已被当前 tag 覆盖）"
          info "   → 检查你的改动是否在配置的 packages 路径下，且 commit message 符合规范"
        else
          info "   → 未检测到发布触发条件，请检查 release-please 日志"
        fi
      elif [[ "$PUB_CONCLUSION" == "failure" ]]; then
        info "   → 发布失败！请查看详细日志: gh run view $run_id --log"
      elif [[ "$PUB_CONCLUSION" == "success" ]]; then
        info "   → 发布成功 ✓"
      fi
      echo ""
    done < <(echo "$RECENT_RUNS" | jq -c '.[]')
  fi

  # 检查当前是否有打开的 release PR
  section "打开的 release PR 检查"
  OPEN_PRS=$(gh pr list --repo "$REPO_URL" --state open --label "autorelease: pending" --json number,title,headRefName,createdAt 2>/dev/null || echo "[]")
  OPEN_PR_COUNT=$(echo "$OPEN_PRS" | jq 'length')
  if [[ "$OPEN_PR_COUNT" -gt 0 ]]; then
    while IFS= read -r pr; do
      pr_num=$(echo "$pr" | jq -r '.number')
      pr_title=$(echo "$pr" | jq -r '.title')
      pr_created=$(echo "$pr" | jq -r '.createdAt')
      warn "有待合并的 release PR: #$pr_num — $pr_title (创建于 $pr_created)"
      info "  → 合并此 PR 即可触发发布: gh pr merge $pr_num --repo $REPO_URL"
    done < <(echo "$OPEN_PRS" | jq -c '.[]')
  else
    pass "没有待合并的 release PR"
  fi
fi

# ================================================================
# 5. dry-run 诊断
# ================================================================
header "5. release-please dry-run"

TOKEN=$(gh auth token 2>/dev/null || true)
if [[ -z "$TOKEN" ]]; then
  fail "无法获取 GitHub token，跳过 dry-run"
else
  DRY_RUN_OUTPUT=$(node_modules/.bin/release-please release-pr \
    --local --local-path=. \
    --dry-run \
    --repo-url="$REPO_URL" \
    --token="$TOKEN" \
    --config-file="$CONFIG_FILE" \
    --manifest-file="$MANIFEST_FILE" \
    2>&1) || true

  # 判断 dry-run 是否真正成功（排除网络错误 / help 输出）
  if echo "$DRY_RUN_OUTPUT" | grep -q "Error: Command failed"; then
    warn "dry-run 网络错误（git fetch 超时或无法连接），跳过远程相关检查"
    if $VERBOSE; then
      info "错误详情:"
      echo "$DRY_RUN_OUTPUT" | grep "Error:" | head -5 | while IFS= read -r line; do info "  $line"; done
    fi
  elif echo "$DRY_RUN_OUTPUT" | grep -q "Options:"; then
    warn "dry-run 输出了帮助信息（参数可能有误），跳过"
  elif echo "$DRY_RUN_OUTPUT" | grep -q "Would open"; then
    N=$(echo "$DRY_RUN_OUTPUT" | grep "Would open" | head -1 | grep -o '[0-9]\+' || echo "?")
    pass "dry-run 成功，将创建 $N 个 PR"

    PR_TITLES=$(echo "$DRY_RUN_OUTPUT" | grep "title:" | sed 's/^.*title: //' || true)
    PR_BRANCHES=$(echo "$DRY_RUN_OUTPUT" | grep "branch:" | sed 's/^.*branch: //' || true)

    info "计划创建的 PR:"
    while IFS= read -r title; do
      [[ -z "$title" ]] && continue
      info "  标题: $title"
    done <<< "$PR_TITLES"
    while IFS= read -r branch; do
      [[ -z "$branch" ]] && continue
      info "  分支: $branch"
    done <<< "$PR_BRANCHES"

    # 检查计划的分支是否已存在 PR
    if [[ -n "$PR_BRANCHES" ]]; then
      section "检查是否已有打开的同名 PR"
      while IFS= read -r branch; do
        [[ -z "$branch" ]] && continue
        EXISTING=$(gh pr list --repo "$REPO_URL" --state open --head "$branch" --json number,title 2>/dev/null | jq -r '.[0] | "PR #\(.number): \(.title)"' 2>/dev/null || true)
        if [[ -n "$EXISTING" && "$EXISTING" != "PR #null: null" ]]; then
          warn "分支 $branch 已有打开的 $EXISTING — 不会创建重复 PR（幂等行为）"
        else
          pass "分支 $branch 无现网冲突"
        fi
      done <<< "$PR_BRANCHES"
    fi

    # 检查计划版本是否已发布（tag 存在）
    if [[ -n "$PR_TITLES" ]]; then
      section "检查计划版本 tag 是否存在"
    fi
    while IFS= read -r title; do
      [[ -z "$title" ]] && continue
      tagname_from_pr=$(echo "$title" | sed -n 's/.*release \([^ ]*\) \([0-9.]*\).*/\1-v\2/p')
      if [[ -n "$tagname_from_pr" ]]; then
        if git rev-parse "$tagname_from_pr" &>/dev/null 2>&1; then
          fail "tag $tagname_from_pr 已存在，但 dry-run 仍要发版！请检查 manifest 版本是否落后于 tag"
        else
          pass "tag $tagname_from_pr 尚未创建（正常）"
        fi
      fi
    done <<< "$PR_TITLES"

  elif echo "$DRY_RUN_OUTPUT" | grep -qi "no commits\|no release\|no changes"; then
    pass "dry-run 成功，当前无需发版（没有新的 conventional commit）"
  else
    warn "dry-run 输出异常，请检查日志"
    if $VERBOSE; then
      info "--- dry-run 完整输出 ---"
      echo "$DRY_RUN_OUTPUT"
      info "--- end ---"
    fi
  fi

  # 5a. conventional commit 统计
  section "conventional commit 统计"
  while IFS= read -r pkg_path; do
    PKG_COMMITS=$(git log --oneline main -- "$pkg_path" 2>/dev/null | wc -l | tr -d ' ')
    PKG_CC=$(echo "$DRY_RUN_OUTPUT" | grep "commits:" | head -1 | grep -o '[0-9]\+' || echo "?")
    info "$pkg_path: 总相关 commit $PKG_COMMITS 个，conventional commit $PKG_CC 个"
  done <<< "$PACKAGES"

  if $VERBOSE; then
    echo ""
    info "--- dry-run 完整输出 ---"
    echo "$DRY_RUN_OUTPUT"
    info "--- end ---"
  fi
fi

# ================================================================
# 6. 远程分支清理建议
# ================================================================
header "6. 远程分支 & PR 清理建议"

git fetch origin --prune &>/dev/null 2>&1 || true
STALE_BRANCHES=$(git branch -r | grep 'release-please' 2>/dev/null || true)
STALE_PRS=$(gh pr list --repo "$REPO_URL" --state open --json number,title,headRefName,createdAt 2>/dev/null \
  | jq -r '.[] | select(.headRefName | startswith("release-please")) | "PR #\(.number): \(.title) (\(.createdAt))"' 2>/dev/null || true)

if [[ -z "$STALE_BRANCHES" && -z "$STALE_PRS" ]]; then
  pass "无残留的 release-please 远程分支/PR"
else
  if [[ -n "$STALE_BRANCHES" ]]; then
    warn "远程存在 release-please 分支:"
    echo "$STALE_BRANCHES" | while IFS= read -r b; do info "  $b"; done
  fi
  if [[ -n "$STALE_PRS" ]]; then
    warn "存在打开的 release-please PR:"
    echo "$STALE_PRS" | while IFS= read -r pr; do info "  $pr"; done
  fi

  echo ""
  info "如需清理，可运行:"
  echo "$STALE_BRANCHES" | while IFS= read -r b; do
    lb=$(echo "$b" | sed 's|origin/||')
    echo "  git push origin --delete $lb"
  done
  echo "$STALE_PRS" | while IFS= read -r pr; do
    pr_num=$(echo "$pr" | grep -o 'PR #\([0-9]\+\)' | grep -o '[0-9]\+')
    [[ -n "$pr_num" ]] && echo "  gh pr close $pr_num --repo $REPO_URL"
  done
fi

# ================================================================
# 7. 发布凭证检查
# ================================================================
header "7. 发布凭证检查"

if [[ -f "$WORKFLOW_FILE" ]]; then
  # 提取所有 secrets.XXX 引用
  REQUIRED_SECRETS=$(grep -o 'secrets\.[A-Z_]*' "$WORKFLOW_FILE" 2>/dev/null | sed 's/secrets\.//' | sort -u || true)

  if [[ -z "$REQUIRED_SECRETS" ]]; then
    info "workflow 中无 secrets 引用"
  else
    # 获取已配置的 secrets 列表
    CONFIGURED_SECRETS=$(gh secret list --repo "$REPO_URL" 2>/dev/null | awk '{print $1}' || true)

    while IFS= read -r secret_name; do
      [[ -z "$secret_name" ]] && continue
      # 跳过 GITHUB_TOKEN（自动提供）
      [[ "$secret_name" == "GITHUB_TOKEN" ]] && continue

      if echo "$CONFIGURED_SECRETS" | grep -qx "$secret_name"; then
        pass "secret \$$secret_name 已配置"
      else
        # 尝试给出更友好的说明
        case "$secret_name" in
          UV_PUBLISH_TOKEN)
            fail "secret \$$secret_name 未配置 — PyPI 发布会失败（需在 https://pypi.org/manage/account/token/ 创建）"
            ;;
          NPM_TOKEN)
            fail "secret \$$secret_name 未配置 — npm 发布会失败"
            ;;
          *)
            fail "secret \$$secret_name 未配置"
            ;;
        esac
      fi
    done <<< "$REQUIRED_SECRETS"
  fi
else
  warn "workflow 文件不存在: $WORKFLOW_FILE（跳过凭证检查）"
fi

# ================================================================
# 8. 综合诊断建议
# ================================================================
header "8. 诊断建议 & 下一步"

FOUND_ACTIONABLE=false

# 检查是否有待合并的 release PR
if command -v gh &>/dev/null; then
  OPEN_RP_PRS=$(gh pr list --repo "$REPO_URL" --state open --label "autorelease: pending" --json number 2>/dev/null | jq 'length' || echo "0")
else
  OPEN_RP_PRS=0
fi

if [[ "$OPEN_RP_PRS" -gt 0 ]]; then
  echo ""
  echo "  ⚠️  当前有 $OPEN_RP_PRS 个待合并的 release PR"
  echo "  → 这是正常流程：release-please 开 PR 后需要人工合并才会发布"
  echo "  → 合并命令: gh pr merge <PR号> --repo $REPO_URL"
  FOUND_ACTIONABLE=true
fi

# 检查上次 run 的 publish 是否被 skip
if [[ -n "${RECENT_RUNS:-}" ]]; then
  LATEST_RUN_ID=$(echo "$RECENT_RUNS" | jq -r '.[0].databaseId')
  LATEST_JOBS=$(gh run view "$LATEST_RUN_ID" --repo "$REPO_URL" --json jobs 2>/dev/null | jq '.jobs' || echo "[]")
  LATEST_PUB=$(echo "$LATEST_JOBS" | jq -r 'map(select(.name | startswith("publish"))) | first // {}')

  HAS_PUB=$(echo "$LATEST_PUB" | jq -r '.name // ""')
  PUB_STATE=$(echo "$LATEST_PUB" | jq -r '.conclusion // ""')

  if [[ -n "$HAS_PUB" && "$PUB_STATE" == "skipped" ]]; then
    echo ""
    echo "  🟡 最后一次 workflow ($LATEST_RUN_ID) 的发布步骤被跳过"
    echo "  → 原因: release-please 只开了 PR，或没有新的 conventional commits"
    echo "  → 如果 PR 已存在: 合并后会自动打 tag 并触发发布"
    echo "  → 如果 0 commits: 确保你的改动在包路径内，commit 以 feat: 或 fix: 开头"
    FOUND_ACTIONABLE=true
  elif [[ -n "$HAS_PUB" && "$PUB_STATE" == "failure" ]]; then
    echo ""
    echo "  🔴 最后一次 workflow ($LATEST_RUN_ID) 的发布步骤失败！"
    echo "  → 查看详细日志: gh run view $LATEST_RUN_ID --log"
    echo "  → 常见原因: secret 未配置、PyPI token 过期、构建失败"
    FOUND_ACTIONABLE=true
  fi
fi

# 检查 dry-run 结果
if echo "${DRY_RUN_OUTPUT:-}" | grep -qi "no commits\|no release\|no changes"; then
  echo ""
  echo "  ℹ️  dry-run 显示当前无需发版（没有新的 conventional commits）"
  echo "  → 确认: commit 是否在包路径下？是否以 feat: 或 fix: 开头？"
  FOUND_ACTIONABLE=true
fi

if [[ "$FOUND_ACTIONABLE" == false ]]; then
  echo ""
  echo "  ✓ 一切正常，未发现需要关注的问题"
fi

# ================================================================
# 摘要
# ================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║             诊断摘要                              ║"
echo "╠══════════════════════════════════════════════════╣"
printf "║  通过: %-2d   警告: %-2d   失败: %-2d             ║\n" "$PASS" "$WARN" "$FAIL"
echo "╚══════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo " 发现 $FAIL 个致命问题，请在发版前修复。"
  exit 1
else
  echo ""
  echo " 一切正常，可以安全发版。" 
  exit 0
fi

"""dev work list 命令 - 统一列出 issue 与 worktree 对应关系

先找出 git worktree 对应的 issue（排最前面），再列出 GitHub 最近前 50 个 open issue。
已由 worktree 覆盖的 issue 不会重复出现在后续列表中。
无 worktree 对应关系的 issue，path/branch 等字段标注 '-'。
"""

import json
import re
from dataclasses import dataclass
from typing import Optional, Annotated

from cyclopts import Parameter
from rich.console import Console
from rich.table import Table

from ._log import VerboseFlag, set_verbosity
from ._git_ops import run, get_main_branch, get_github_repo, parse_issue_number
from ._gh_ops import gh_issue_list, gh_issue_view, gh_all_prs_map


# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------


@dataclass
class IssueRow:
    """统一的行数据结构"""

    issue_number: int
    issue_title: str
    issue_state: str
    issue_url: str
    issue_created: str
    issue_author: str
    # worktree 关联字段（无关联时为 '-'）
    worktree_path: str = "-"
    branch: str = "-"
    ahead: int = 0
    is_prunable: bool = False
    # PR 信息
    pr_number: str = "-"
    pr_state: str = "-"
    pr_mergeable: str = "-"
    is_draft: bool = False


@dataclass
class WorktreeInfo:
    path: str
    short_path: str
    branch: str
    ahead: int
    is_prunable: bool
    has_uncommitted: bool


# ---------------------------------------------------------------------------
# Worktree 扫描
# ---------------------------------------------------------------------------


def git_worktree_list(cwd: Optional[str] = None) -> list[WorktreeInfo]:
    """解析 git worktree list 输出"""
    main_branch = get_main_branch()
    raw = run("git worktree list", cwd)
    results: list[WorktreeInfo] = []

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue

        parts = line.split()
        if len(parts) < 3:
            continue

        full_path = parts[0]
        bracket_match = re.search(r"\[(.+?)\]", line)
        branch = bracket_match.group(1).strip() if bracket_match else ""

        # 缩短路径
        cwd_root = cwd or run("pwd")
        if full_path == cwd_root:
            short_path = "."
        elif full_path.startswith(cwd_root + "/"):
            short_path = full_path[len(cwd_root) + 1 :]
        else:
            short_path = full_path

        # ahead 计数
        ahead = 0
        if branch and branch != main_branch:
            try:
                ahead_str = run(f'git rev-list --count "{main_branch}..{branch}"')
                ahead = int(ahead_str)
            except (RuntimeError, ValueError):
                pass

        # 未提交变更
        has_uncommitted = False
        try:
            status_out = run("git status --porcelain", full_path)
            if status_out.strip():
                has_uncommitted = True
        except RuntimeError:
            pass

        results.append(
            WorktreeInfo(
                path=full_path,
                short_path=short_path,
                branch=branch,
                ahead=ahead,
                is_prunable=(branch == ""),
                has_uncommitted=has_uncommitted,
            )
        )

    return results


# ---------------------------------------------------------------------------
# 核心：合并 issue 与 worktree
# ---------------------------------------------------------------------------


def build_unified_rows(
    repo: str,
    labels: Optional[str] = None,
) -> list[IssueRow]:
    """构建统一的 issue-worktree 行列表

    流程:
    1. 扫描所有 git worktree，匹配对应的 issue
    2. 从 GitHub 获取最近 50 个 open issue
    3. 将 worktree 已覆盖的 issue 排在前面，其余跟在后面
    """
    # 1. 扫描 worktree
    worktrees = git_worktree_list()

    # 2. 获取所有 PR 映射
    pr_map = gh_all_prs_map(repo)

    # 3. 为每个 worktree 构建 IssueRow
    covered_issue_numbers: set[int] = set()
    wt_rows: list[IssueRow] = []

    main_branch = get_main_branch()
    for wt in worktrees:
        # 跳过主分支 worktree（main/master），它不属于任何 issue
        if wt.branch == main_branch:
            continue
        issue_num = parse_issue_number(wt.branch)
        branch_display = wt.branch + ("*" if wt.has_uncommitted else "")

        # 默认值（无 issue 对应的 worktree）
        row = IssueRow(
            issue_number=0,
            issue_title="-",
            issue_state="-",
            issue_url="-",
            issue_created="-",
            issue_author="-",
            worktree_path=wt.short_path + (" *prunable*" if wt.is_prunable else ""),
            branch=branch_display,
            ahead=wt.ahead,
            is_prunable=wt.is_prunable,
            pr_number="-",
            pr_state="-",
        )

        # 尝试获取关联的 issue
        if issue_num:
            covered_issue_numbers.add(issue_num)
            try:
                issue = gh_issue_view(issue_num, repo)
                author = issue.get("author", {})
                author_login = (
                    author.get("login", "-") if isinstance(author, dict) else "-"
                )
                row.issue_number = issue["number"]
                row.issue_title = issue.get("title", "-")
                row.issue_state = issue.get("state", "-")
                row.issue_url = issue.get("url", "-")
                row.issue_created = issue.get("createdAt", "-")
                row.issue_author = author_login
            except RuntimeError:
                pass

            # PR 信息
            pr = pr_map.get(wt.branch)
            if pr:
                row.pr_number = str(pr["number"])
                row.pr_state = pr.get("state", "-")
                row.pr_mergeable = pr.get("mergeable", "-")
                row.is_draft = pr.get("isDraft", False)
                # PR 已合并时标记可 prune
                if pr.get("state") == "MERGED":
                    row.is_prunable = True

        wt_rows.append(row)

    # 4. 获取 GitHub open issues（排除已覆盖的）
    try:
        all_issues = gh_issue_list(repo, state="open", limit=50, labels=labels)
    except RuntimeError:
        all_issues = []

    issue_rows: list[IssueRow] = []
    for iss in all_issues:
        num = iss["number"]
        if num in covered_issue_numbers:
            continue
        author = iss.get("author", {})
        author_login = author.get("login", "-") if isinstance(author, dict) else "-"
        issue_rows.append(
            IssueRow(
                issue_number=num,
                issue_title=iss.get("title", "-"),
                issue_state=iss.get("state", "-"),
                issue_url=iss.get("url", "-"),
                issue_created=iss.get("createdAt", "-"),
                issue_author=author_login,
                worktree_path="-",
                branch="-",
                ahead=0,
                is_prunable=False,
                pr_number="-",
                pr_state="-",
            )
        )

    return wt_rows + issue_rows


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def work_list(
    verbose: VerboseFlag = 0,
    labels: Annotated[
        Optional[str],
        Parameter(
            name=["--label", "-l"],
            help="按标签过滤 issue",
        ),
    ] = None,
    json_output: Annotated[
        bool,
        Parameter(
            name="--json",
            help="输出 JSON 格式",
        ),
    ] = False,
):
    """列出 issue，并标出与 worktree 的对应关系。

    先列出有 worktree 对应的 issue（正在开发中），再列出其余最近 open issue。
    无 worktree 对应关系的 issue，path/branch 等字段标注 '-'。
    """
    set_verbosity(verbose)
    repo = get_github_repo()
    rows = build_unified_rows(repo, labels)

    if json_output:
        result = []
        for r in rows:
            result.append(
                {
                    "issue": {
                        "number": r.issue_number if r.issue_number > 0 else None,
                        "title": r.issue_title,
                        "state": r.issue_state,
                        "url": r.issue_url,
                        "created": r.issue_created,
                        "author": r.issue_author,
                    },
                    "worktree": {
                        "path": r.worktree_path,
                        "branch": r.branch,
                        "ahead": r.ahead,
                        "is_prunable": r.is_prunable,
                    },
                    "pr": {
                        "number": r.pr_number if r.pr_number != "-" else None,
                        "state": r.pr_state if r.pr_state != "-" else None,
                        "mergeable": r.pr_mergeable if r.pr_mergeable != "-" else None,
                        "isDraft": r.is_draft,
                    },
                    "prune": r.is_prunable,
                }
            )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    if not rows:
        print("没有 open issue")
        return

    # Rich 表格输出
    console = Console()
    table = Table(
        show_header=True,
        header_style="bold dim",
        border_style="dim",
        expand=True,
    )
    table.add_column("Issue", no_wrap=True, width=7)
    table.add_column("State", no_wrap=True, width=6)
    table.add_column("Created", no_wrap=True, width=10)
    table.add_column("Title", no_wrap=True, max_width=40)
    table.add_column("Worktree", no_wrap=True, max_width=35)
    table.add_column("Ahead", justify="right", width=5)
    table.add_column("PR", no_wrap=True, max_width=12)
    table.add_column("PR State", no_wrap=True, width=7)
    table.add_column("Mergeable", no_wrap=True, width=10)

    for r in rows:
        issue_str = f"#{r.issue_number}" if r.issue_number > 0 else "-"
        created_short = r.issue_created[:10] if r.issue_created != "-" else "-"
        title = r.issue_title

        # 构建 worktree 展示列：path [branch]（可 prune 时加标记）
        if r.worktree_path != "-":
            wt_display = r.worktree_path
            if r.branch:
                wt_display += f" [{r.branch}]"
            if r.is_prunable:
                wt_display += " [bold red]🗑[/]"
        else:
            wt_display = "-"

        # PR 信息
        pr_display = "-"
        pr_state = "-"
        pr_mergeable = "-"
        if r.pr_number != "-":
            pr_display = f"#{r.pr_number}"
            if r.is_draft:
                pr_state = f"[yellow]{r.pr_state} 草稿[/]"
                pr_mergeable = (
                    "[yellow]BLOCKED(草稿)[/]"
                    if r.pr_mergeable != "CONFLICTING"
                    else f"[yellow]{r.pr_mergeable}[/]"
                )
            else:
                pr_state = r.pr_state
                pr_mergeable = r.pr_mergeable

        ahead_str = str(r.ahead) if r.ahead > 0 else "-"

        # 有 worktree 的行高亮
        style = "bold" if r.worktree_path != "-" else None

        table.add_row(
            issue_str,
            r.issue_state,
            created_short,
            title,
            wt_display,
            ahead_str,
            pr_display,
            pr_state,
            pr_mergeable,
            style=style,
        )

    # 统计
    wt_count = sum(1 for r in rows if r.worktree_path != "-")
    issue_count = sum(1 for r in rows if r.worktree_path == "-")

    console.print(table)
    console.print(
        f"\n[dim]共 {wt_count} 个 worktree 关联 + {issue_count} 个待处理 issue[/dim]"
    )

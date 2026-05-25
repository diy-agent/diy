"""dev work status - 当前分支详情（Git + Issue + PR + 分支拓扑）"""

from cyclopts import App, Parameter
from typing import Annotated

from ._log import VerboseFlag, set_verbosity
from ._git_ops import (
    run,
    get_github_repo,
    get_main_branch,
    get_current_branch,
    get_merge_base,
)
from ._gh_ops import gh_issue_view, gh_pr_list

status_app = App(name="status", help="当前分支详情")


@status_app.default
def work_status(
    verbose: VerboseFlag = 0,
):
    """显示当前分支的 Git 状态、关联 Issue、PR 信息及分支拓扑图。"""
    set_verbosity(verbose)
    branch = get_current_branch()
    main_branch = get_main_branch()
    repo = get_github_repo()

    # === Git 信息 ===
    print("=== Git 信息 ===")
    print(f"  分支:             {branch}")
    print(f"  基准分支:         {main_branch}")
    print(f"  仓库:             {repo}")

    status_out = run("git status --porcelain")
    if status_out.strip():
        count = len([l for l in status_out.split("\n") if l.strip()])
        print(f"  变更:             {count} 个文件未提交")
    else:
        print("  变更:             干净")

    if branch != main_branch:
        try:
            ahead = int(run(f'git rev-list --count "{main_branch}..{branch}"'))
            behind = int(run(f'git rev-list --count "{branch}..{main_branch}"'))
            if ahead > 0 or behind > 0:
                print(f"  追踪:             ↑{ahead} ahead, ↓{behind} behind {main_branch}")
        except (RuntimeError, ValueError):
            pass

    # === Issue 信息 ===
    issue_num = None
    for pattern, parser in [
        (r"^(\d+)-", 1),
        (r"^issue-(\d+)$", 1),
        (r"^(\d+)$", 1),
    ]:
        import re
        m = re.match(pattern, branch)
        if m:
            issue_num = int(m.group(parser))
            break

    if not issue_num:
        print(f'\n⚠ 分支 "{branch}" 无法解析 issue 编号')
        return

    print(f"\n=== Issue 信息 ===")
    try:
        data = gh_issue_view(issue_num, repo, "number,title,state,url,createdAt,author")
        author = data.get("author", {})
        author_login = author.get("login", "-") if isinstance(author, dict) else "-"
        print(f"  #{data['number']}  {data['title']}")
        print(f"  状态:           {data['state']}")
        print(f"  作者:           {author_login}")
        print(f"  创建:           {data.get('createdAt', '-')}")
        print(f"  URL:            {data.get('url', '-')}")
    except RuntimeError as e:
        print(f"  无法获取 issue #{issue_num}: {e}")

    # === PR 信息 ===
    print("\n=== PR 信息 ===")
    try:
        prs = gh_pr_list(repo, head=branch)
        if prs:
            pr = prs[0]
            print(f"  #{pr['number']}  {pr['title']}")
            print(f"  状态:           {pr['state']}{' (草稿)' if pr.get('isDraft') else ''}")
            mergeable = pr.get('mergeable', 'UNKNOWN')
            if pr.get('isDraft') and mergeable != 'CONFLICTING':
                mergeable = 'BLOCKED(草稿)'
            print(f"  可合并:         {mergeable}")
            print(f"  URL:            {pr['url']}")
        else:
            print("  未找到关联 PR")
    except RuntimeError:
        print("  无法获取 PR 信息")

    # === 分支示意图 ===
    print("\n=== 分支拓扑 ===")
    diagram = _build_branch_diagram(branch, main_branch)
    print(diagram)
    print()


def _build_branch_diagram(branch: str, main_branch: str) -> str:
    """构建当前分支的 ASCII 拓扑图"""
    try:
        merge_base = get_merge_base(branch, main_branch)[:7]
    except RuntimeError:
        merge_base = "?"

    branch_commits: list[str] = []
    try:
        raw = run(f'git log --oneline "{merge_base}..{branch}"')
        branch_commits = [l[:7] for l in raw.split("\n") if l]
    except RuntimeError:
        pass

    main_commits: list[str] = []
    try:
        raw = run(f'git log --oneline "{merge_base}..{main_branch}"')
        main_commits = [l[:7] for l in raw.split("\n") if l]
    except RuntimeError:
        pass

    lines: list[str] = []
    indent = "  "

    if not main_commits:
        lines.append(f"{indent}main: ...---{merge_base}")
    else:
        lines.append(f"{indent}main: ...---{merge_base}---" + "---".join(main_commits))

    if branch_commits:
        lines.append(f"{indent}      \\")
        lines.append(f"{indent}{branch}:  " + "---".join(branch_commits))

    lines.append("")
    lines.append(
        f"  merge-base: {merge_base}  "
        f"· {branch} ahead {len(branch_commits)}  "
        f"· {main_branch} ahead {len(main_commits)}"
    )
    return "\n".join(lines)

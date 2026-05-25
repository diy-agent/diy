"""dev work start - 开始开发：创建 worktree 并推送

对应原 flow issue dev 功能：
  从 GitHub issue 编号创建对应的 git worktree，分支命名 ＜issueNum＞ 或 ＜issueNum＞-＜name＞
"""

from cyclopts import App, Parameter
from typing import Annotated

from ._log import VerboseFlag, set_verbosity
from ._git_ops import (
    get_github_repo,
    get_main_branch,
    git_worktree_add,
    git_push_upstream,
)
from ._gh_ops import gh_issue_view
from ._config import WORKTREE_DIR

start_app = App(name="start", help="开始开发：创建 worktree 并推送")


@start_app.default
def work_start(
    issue_num: Annotated[int, Parameter(
        name=["issue_num"],
        help="GitHub issue 编号",
    )],
    branch_name: Annotated[str, Parameter(
        name=["branch_name"],
        help="分支名后缀（可选）",
    )] = "",
    verbose: VerboseFlag = 0,
):
    """从 issue 编号开始开发，创建 worktree 并推送远程分支。

    示例:
      dev start 54           # 创建分支 54，worktree 在 .worktree/54
      dev start 54 fix-xx    # 创建分支 54-fix-xx
    """
    set_verbosity(verbose)
    repo = get_github_repo()
    main_branch = get_main_branch()
    branch = f"{issue_num}-{branch_name}" if branch_name else str(issue_num)

    # 先验证 issue 是否存在
    try:
        issue = gh_issue_view(issue_num, repo, "title")
        print(f"Issue:  #{issue_num}  {issue.get('title', '')}")
    except RuntimeError as e:
        print(f"错误: 无法获取 issue #{issue_num} - {e}")
        return

    # 创建 worktree
    worktree_path = f"{WORKTREE_DIR}/{branch}"
    try:
        git_worktree_add(branch, main_branch)
        print(f"成功: 创建 worktree {worktree_path}")
    except RuntimeError as e:
        print(f"错误: 创建 worktree 失败 - {e}")
        return

    # 推送分支
    try:
        git_push_upstream(branch)
        print(f"成功: 推送分支 {branch} 到远程")
    except RuntimeError as e:
        print(f"警告: 推送分支失败 - {e}")
        print(f"请手动推送: git push -u origin {branch}")

    print(f"\n开始开发: cd {worktree_path}")

"""dev work new - 创建新 GitHub issue"""

from cyclopts import App, Parameter
from typing import Annotated

from .log import VerboseFlag, set_verbosity
from .git_ops import get_github_repo
from .gh_ops import gh_issue_create

new_app = App(name="new", help="创建新的 issue")


@new_app.default
def work_new(
    description: Annotated[list[str], Parameter(
        name=["description"],
        help="issue 描述（同时作为 title 和 body）",
    )],
    verbose: VerboseFlag = 0,
):
    """创建新的 GitHub issue，描述同时作为 title 和 body。

    示例:
      dev new 修复登录页面样式问题
      dev new 需要支持多语言切换功能
    """
    set_verbosity(verbose)
    repo = get_github_repo()
    desc = " ".join(description)
    num = gh_issue_create(desc, desc, repo)
    print(f"成功: 创建 issue #{num}")
    print(f"URL:   https://github.com/{repo}/issues/{num}")

"""diydev CLI 入口 - dev 根命令"""

import sys
from cyclopts import App

from .list_cmd import work_list
from .start_cmd import start_app
from .new_cmd import new_app
from .status_cmd import status_app
from .pr_cmd import pr_app
from .merge_pr_cmd import merge_pr_app
from .prune_cmd import prune_app

app = App(
    name="dev",
    help="diy 开发流程管理",
)

# dev list
app.command(work_list, name="list")

# dev start
app.command(start_app, name="start")

# dev new
app.command(new_app, name="new")

# dev status
app.command(status_app, name="status")

# dev pr
app.command(pr_app, name="pr")

# dev merge-pr
app.command(merge_pr_app, name="merge-pr")

# dev prune
app.command(prune_app, name="prune")


def main():
    """CLI 入口函数"""
    try:
        app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])
    except Exception as e:
        # cyclopts 已用 Rich 打印错误消息，不再重复输出 traceback
        sys.exit(1)


if __name__ == "__main__":
    main()

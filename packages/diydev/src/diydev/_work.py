"""work 子命令模块 - 工作区管理"""

from cyclopts import App

from ._list_cmd import work_list
from ._start_cmd import start_app
from ._new_cmd import new_app
from ._status_cmd import status_app
from ._pr_cmd import pr_app
from ._merge_pr_cmd import merge_pr_app
from ._prune_cmd import prune_app

work_app = App(name="work", help="工作区管理")

# dev work list
work_app.command(work_list, name="list")

# dev work start
work_app.command(start_app, name="start")

# dev work new
work_app.command(new_app, name="new")

# dev work status
work_app.command(status_app, name="status")

# dev work pr
work_app.command(pr_app, name="pr")

# dev work merge-pr
work_app.command(merge_pr_app, name="merge-pr")

# dev work prune
work_app.command(prune_app, name="prune")

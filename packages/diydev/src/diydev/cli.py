"""diydev CLI 入口 - dev 根命令"""

import sys
from typing import Annotated
from cyclopts import App, Parameter, Group

from .log import VerboseFlag, set_verbosity
from .list_cmd import work_list
from .start_cmd import start_app
from .new_cmd import new_app
from .status_cmd import status_app
from .pr_cmd import pr_app
from .merge_pr_cmd import merge_pr_app
from .prune_cmd import prune_app

_GLOBAL_GROUP = Group("全局选项")

VerboseRoot = Annotated[int, Parameter(
    name=["--verbose", "-v"],
    count=True,
    group=_GLOBAL_GROUP,
    help="冗余级别: -v=INFO, -vv=DEBUG, -vvv=TRACE",
)]

app = App(
    name="dev",
    help="diy 开发流程管理",
    version_flags=[],
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


@app.default
def root(verbose: VerboseRoot = 0):
    """diy 开发流程管理"""
    set_verbosity(verbose)


# 解析 -v/-vv/-vvv 并从 argv 中移除，再交给 cyclopts 处理
# 这样 "dev -v list" (选项在子命令前) 也能生效
def _strip_verbose(argv: list[str]) -> tuple[int, list[str]]:
    """从 argv 中提取 -v 计数并返回 (verbosity, remaining_argv)"""
    verbose = 0
    remaining: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--verbose":
            verbose += 1
            i += 1
        elif arg.startswith("--verbose="):
            try:
                verbose += int(arg.split("=", 1)[1])
            except ValueError:
                verbose += 1
            i += 1
        elif arg.startswith("-") and not arg.startswith("--") and "v" in arg.lstrip("-"):
            trimmed = arg.lstrip("-")
            verbose += trimmed.count("v")
            # 保留非 v 的 flag 字符
            rest = trimmed.replace("v", "")
            if rest:
                remaining.append(f"-{rest}")
            i += 1
        else:
            remaining.append(arg)
            i += 1
    return verbose, remaining


def main():
    """CLI 入口函数"""
    raw = sys.argv[1:]
    verbose, args = _strip_verbose(raw)
    set_verbosity(verbose)
    try:
        app(args if args else ["--help"])
    except Exception:
        # cyclopts 已用 Rich 打印错误消息，不再重复输出 traceback
        sys.exit(1)


if __name__ == "__main__":
    main()

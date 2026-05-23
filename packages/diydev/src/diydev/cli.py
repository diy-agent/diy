"""diydev CLI 入口 - dev 根命令，子命令 work"""

import sys
from cyclopts import App

from .work import work_app

app = App(
    name="dev",
    help="diy 开发流程管理",
)

# 将 work 作为子命令注册
app.command(work_app, name="work")


def main():
    """CLI 入口函数"""
    try:
        app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])
    except Exception as e:
        # cyclopts 已用 Rich 打印错误消息，不再重复输出 traceback
        sys.exit(1)


if __name__ == "__main__":
    main()

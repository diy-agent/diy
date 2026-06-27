"""diy CLI 入口"""

import sys
from importlib.metadata import version
from typing import Annotated
from cyclopts import App, Parameter, Group

from . import _dai_cli
from ._log import set_verbosity, logger
from .llm import llm_app
from .ref import ref_app
from .llm.auth import load_dotenv

_GLOBAL_GROUP = Group("全局选项")

VerboseRoot = Annotated[
    int,
    Parameter(
        name=["--verbose", "-v"],
        count=True,
        group=_GLOBAL_GROUP,
        help="冗余级别: -v=INFO, -vv=DEBUG, -vvv=TRACE",
    ),
]

app = App(
    name="diy",
    help="diy 统一管理工具",
    version=version("diy-cli"),
    version_flags=["--version", "-V"],
)

app.command(llm_app)
app.command(ref_app)

# 注册 dai 子命令组到 diy
app.command(_dai_cli.task_app)
app.command(_dai_cli.subject_app)
app.command(_dai_cli.profile_app)
app.command(_dai_cli.agent_app)
app.command(_dai_cli.ui_app)


@app.command
def restart():
    """重启管控台。"""
    _dai_cli._app_restart()


@app.command
def shutdown():
    """关闭管控台。"""
    _dai_cli._local_shutdown()


@app.command(name="doctor")
def doctor():
    """分层健康自检 — app 状态 / socket / state.yaml。"""
    _dai_cli.doctor_cmd()


# 复用 _dai_cli 的 scan 函数
# 注意：_dai_cli.scan 已注册在 _dai_cli.app 上，但 app.command() 不会冲突
# 因为它是不同的 App 实例
app.command(_dai_cli.scan)

@app.default
def root(verbose: VerboseRoot = 0):
    """diy 统一管理工具"""
    set_verbosity(verbose)

def _strip_verbose(argv: list[str]) -> tuple[int, list[str]]:
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
        elif (
            arg.startswith("-") and not arg.startswith("--") and "v" in arg.lstrip("-")
        ):
            trimmed = arg.lstrip("-")
            verbose += trimmed.count("v")
            rest = trimmed.replace("v", "")
            if rest:
                remaining.append(f"-{rest}")
            i += 1
        else:
            remaining.append(arg)
            i += 1
    return verbose, remaining

def main():
    load_dotenv()
    raw = sys.argv[1:]
    verbose, args = _strip_verbose(raw)
    set_verbosity(verbose)
    if not args:
        app(["--help"])
        return

    # 限制仅在纯 flag 时才本地处理 — help/version
    cmd = args[0]
    if cmd in ("--help", "-h", "--version", "-V"):
        app(args)
        return

    # 本地执行的命令（不走 socket）
    local_cmds = {"restart", "shutdown", "agent", "doctor", "llm", "ref", "scan",
                   "--help", "-h", "--version", "-V"}
    cmd = args[0]
    if cmd in local_cmds:
        app(args)
        return

    # 其余全部转发到管控台（task/subject/profile/ui/chat/edit/...）
    from ._forward import forward_to_app

    forward_to_app(["diy"] + args)

if __name__ == "__main__":
    main()

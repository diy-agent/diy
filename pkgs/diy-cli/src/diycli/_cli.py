"""diycli CLI 入口"""

import sys
from importlib.metadata import version
from typing import Annotated
from cyclopts import App, Parameter, Group

from ._log import set_verbosity, logger
from ._sync import sync_dependencies
from .llm import llm_app
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

@app.command(name="sync")
def sync_cmd():
    """同步项目依赖源码到 .diy"""
    try:
        sync_dependencies()
    except FileNotFoundError as e:
        logger.error(str(e))
        sys.exit(1)
    except Exception as e:
        logger.error("同步过程中发生未知错误", e)
        sys.exit(1)

app.command(llm_app)

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
    try:
        app(args if args else ["--help"])
    except Exception:
        sys.exit(1)

if __name__ == "__main__":
    main()

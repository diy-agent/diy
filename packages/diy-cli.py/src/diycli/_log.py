"""日志工具 - 分级输出到 stderr"""

import sys
from typing import Annotated
from cyclopts import Parameter, Group

_verbosity: int = 0

_PREFIX = {
    1: "INFO ",
    2: "DEBUG",
    3: "TRACE",
}

_STYLE = {
    1: "\033[36m",  # cyan
    2: "\033[33m",  # yellow
    3: "\033[90m",  # gray/bright-black
}
_RESET = "\033[0m"

VerboseFlag = Annotated[
    int,
    Parameter(
        name=["--verbose", "-v"],
        count=True,
        group=Group("全局选项"),
        help="冗余级别: -v=INFO, -vv=DEBUG, -vvv=TRACE",
    ),
]

def set_verbosity(level: int) -> None:
    global _verbosity
    _verbosity = max(_verbosity, level)

def verbosity() -> int:
    return _verbosity

def _emit(level: int, msg: str, tag: str = None) -> None:
    if _verbosity < level:
        return
    prefix = _PREFIX.get(level, "??????")
    style = _STYLE.get(level, "")
    tag_str = f" [{tag}]" if tag else ""
    
    if not sys.stderr.isatty():
        print(f"[{prefix}]{tag_str} {msg}", file=sys.stderr)
    else:
        print(f"{style}[{prefix}]{_RESET}{tag_str} {msg}", file=sys.stderr)

def info(msg: str, tag: str = None) -> None:
    _emit(1, msg, tag)

def debug(msg: str, tag: str = None) -> None:
    _emit(2, msg, tag)

def trace(msg: str, tag: str = None) -> None:
    _emit(3, msg, tag)

def success(msg: str, tag: str = None) -> None:
    # Use cyan/green for success
    if not sys.stderr.isatty():
        print(f"[SUCCESS] {msg}", file=sys.stderr)
    else:
        print(f"\033[32m[SUCCESS]\033[0m {msg}", file=sys.stderr)

def error(msg: str, tag: str = None) -> None:
    if not sys.stderr.isatty():
        print(f"[ERROR] {msg}", file=sys.stderr, flush=True)
    else:
        print(f"\033[31m[ERROR]\033[0m {msg}", file=sys.stderr, flush=True)

class Logger:
    def __init__(self, tag: str = None):
        self.tag = tag
    
    def info(self, msg: str): info(msg, self.tag)
    def debug(self, msg: str): debug(msg, self.tag)
    def trace(self, msg: str): trace(msg, self.tag)
    def success(self, msg: str): success(msg, self.tag)
    def error(self, msg: str, err: Exception = None):
        if err:
            error(f"{msg} {err}", self.tag)
        else:
            error(msg, self.tag)
    
    def with_tag(self, tag: str):
        return Logger(tag)

logger = Logger()

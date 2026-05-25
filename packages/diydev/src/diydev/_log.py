"""日志工具 - 分级输出到 stderr

级别映射:
  -v   → INFO  : 命令执行信息
  -vv  → DEBUG : 命令执行结果
  -vvv → TRACE : 详细追踪
"""

import sys
from typing import Annotated

from cyclopts import Parameter, Group

# 全局冗余级别: 0=静默, 1=INFO, 2=DEBUG, 3=TRACE
_verbosity: int = 0

_PREFIX = {
    1: "INFO ",
    2: "DEBUG",
    3: "TRACE",
}

_STYLE = {
    1: "\033[36m",   # cyan
    2: "\033[33m",   # yellow
    3: "\033[90m",   # gray/bright-black
}
_RESET = "\033[0m"

# 可复用的 cyclopts 参数类型，添加到每个子命令签名即可注册 -v 到 help
VerboseFlag = Annotated[int, Parameter(
    name=["--verbose", "-v"],
    count=True,
    group=Group("全局选项"),
    help="冗余级别: -v=INFO, -vv=DEBUG, -vvv=TRACE",
)]


def set_verbosity(level: int) -> None:
    """设置冗余级别（取较大值，不覆盖已有设定）"""
    global _verbosity
    _verbosity = max(_verbosity, level)


def verbosity() -> int:
    """返回当前冗余级别"""
    return _verbosity


def _emit(level: int, msg: str) -> None:
    """输出带前缀的日志到 stderr"""
    if _verbosity < level:
        return
    prefix = _PREFIX.get(level, "??????")
    style = _STYLE.get(level, "")
    # 不带颜色时直接输出
    if not sys.stderr.isatty():
        print(f"[{prefix}] {msg}", file=sys.stderr)
    else:
        print(f"{style}[{prefix}]{_RESET} {msg}", file=sys.stderr)


def info(msg: str) -> None:
    """INFO 级别 (-v): 命令执行信息等"""
    _emit(1, msg)


def debug(msg: str) -> None:
    """DEBUG 级别 (-vv): 命令执行结果等"""
    _emit(2, msg)


def trace(msg: str) -> None:
    """TRACE 级别 (-vvv): 详细追踪信息"""
    _emit(3, msg)

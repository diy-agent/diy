"""日志工具 — 分级输出到 stderr，供所有 CLI 模块统一使用。

级别映射:
  -v   → INFO  : 命令执行信息
  -vv  → DEBUG : 命令执行结果
  -vvv → TRACE : 详细追踪

用法:
  from diy.core._log import info, error, warn
  info("正在启动管控台...")
  error("启动失败")
"""

from __future__ import annotations

import sys
from typing import Annotated

from cyclopts import Group, Parameter

# 全局冗余级别: 0=静默, 1=INFO, 2=DEBUG, 3=TRACE
_verbosity: int = 1  # 默认 INFO

_PREFIX = {
    1: "INFO ",
    2: "DEBUG",
    3: "TRACE",
    4: "WARN ",
    5: "ERROR",
}

_STYLE = {
    1: "\033[36m",  # cyan
    2: "\033[33m",  # yellow
    3: "\033[90m",  # gray
    4: "\033[93m",  # bright yellow
    5: "\033[91m",  # red
}
_RESET = "\033[0m"


def _should_emit(level: int) -> bool:
    """判断是否应该输出（告警/错误不受 verbose 控制）。"""
    if level >= 4:  # WARN / ERROR always visible
        return True
    return _verbosity >= level


def _emit(level: int, msg: str, *args) -> None:
    """输出带前缀的日志到 stderr。"""
    if not _should_emit(level):
        return
    text = msg % args if args else msg
    prefix = _PREFIX.get(level, "??????")
    style = _STYLE.get(level, "")
    if not sys.stderr.isatty():
        print(f"[{prefix}] {text}", file=sys.stderr)
    else:
        print(f"{style}[{prefix}]{_RESET} {text}", file=sys.stderr)


# ── 公开 API ──


def set_verbosity(level: int) -> None:
    """设置冗余级别（取较大值，不覆盖已有设定）。"""
    global _verbosity
    _verbosity = max(_verbosity, level)


def verbosity() -> int:
    return _verbosity


def info(msg: str, *args) -> None:
    """INFO 级别 (-v): 命令执行信息等。"""
    _emit(1, msg, *args)


def debug(msg: str, *args) -> None:
    """DEBUG 级别 (-vv): 命令执行结果等。"""
    _emit(2, msg, *args)


def trace(msg: str, *args) -> None:
    """TRACE 级别 (-vvv): 详细追踪信息。"""
    _emit(3, msg, *args)


def warn(msg: str, *args) -> None:
    """WARN: 警告。"""
    _emit(4, msg, *args)


def error(msg: str, *args) -> None:
    """ERROR: 错误。"""
    _emit(5, msg, *args)


# ── 可复用的 cyclopts 参数类型 ──

VerboseFlag = Annotated[
    int,
    Parameter(
        name=["--verbose", "-v"],
        count=True,
        group=Group("全局选项"),
        help="冗余级别: -v=INFO, -vv=DEBUG, -vvv=TRACE",
    ),
]

"""测试辅助工具：tree snapshot + event log。"""

from __future__ import annotations

import contextlib
import inspect
from collections.abc import Callable, Generator
from typing import Any

import diyui


# ══════════════════════════════════════════════════════════════════
# Tree Snapshot
# ══════════════════════════════════════════════════════════════════


def tree_snapshot(node: diyui.ScopeNode, *, max_depth: int = 10) -> str:
    """将 ScopeNode 树渲染为可读文本，用于意图测试断言。"""
    lines: list[str] = []
    _render_node(node, lines, indent=0, max_depth=max_depth)
    return "\n".join(lines)


def _render_node(
    node: diyui.ScopeNode,
    lines: list[str],
    indent: int,
    max_depth: int,
) -> None:
    label = _node_label(node)
    prefix = "  " * indent
    lines.append(f"{prefix}{label}")
    children = node._children
    for child in children:
        if indent >= max_depth:
            lines.append(f"{prefix}  ...")
            break
        _render_node(child, lines, indent + 1, max_depth)


def _node_label(node: diyui.ScopeNode) -> str:
    """生成节点标签。

    依次拼装：_tree_label() 或类名 → signal 值 → rerun_count → error。
    """
    if hasattr(node, "_tree_label"):
        base = node._tree_label()  # type: ignore[no-any-return]
    else:
        base = type(node).__name__

    extras: list[str] = []

    # signal 值
    sigs: list[object] = getattr(node, "_signals", [])  # type: ignore[no-any-return]
    if sigs:
        for s in sigs:
            sig_name = _signal_name(s)
            extras.append(f"{sig_name}={s.value!r}")  # type: ignore[attr-defined]

    # cell rerun 次数
    if node._cell_fn is not None:  # type: ignore[attr-defined]
        debug = diyui.get_debug(node)
        if debug.rerun_count > 0:
            extras.append(f"rerun={debug.rerun_count}")

    # 错误
    if node._cell_fn is not None:  # type: ignore[attr-defined]
        debug = diyui.get_debug(node)
        if debug.has_error:
            extras.append("ERR")

    if extras:
        return f"{base} [{', '.join(extras)}]"
    return base


def _signal_name(sig: object) -> str:
    """获取 signal 的可读名称。"""
    # 尝试从 owner class 中找属性名
    owner = getattr(sig, "owner", None)  # type: ignore[attr-defined]
    if owner is not None:
        for name, val in inspect.getmembers(owner):
            if val is sig:
                return name
    return "signal"


# ══════════════════════════════════════════════════════════════════
# Event Log
# ══════════════════════════════════════════════════════════════════


class EventLog:
    """收集 scope tree 运行时事件。"""

    def __init__(self) -> None:
        self._events: list[str] = []
        self._hooks: list[Callable[[], None]] = []

    def record(self, event: str) -> None:
        self._events.append(event)

    @property
    def events(self) -> list[str]:
        return list(self._events)

    def clear(self) -> None:
        self._events.clear()

    def __eq__(self, other: object) -> bool:
        if isinstance(other, list):
            return self._events == other
        return NotImplemented


@contextlib.contextmanager
def collect_events(
    app: diyui.BaseApp, log: EventLog | None = None
) -> Generator[EventLog, None, None]:
    """上下文管理器：收集 scope tree 运行时事件。

    通过 monkey-patch signal 的 _notify 和 cell 的 _execute_cell 实现。
    """
    if log is None:
        log = EventLog()

    # patch signal._trigger_cells 记录事件
    from diyui._signal import Signal

    _original_trigger_cells = Signal._trigger_cells

    def _trigger_cells_with_log(self: Signal[Any]) -> None:  # type: ignore[name-defined]
        owner = getattr(self, "owner", None)
        log.record(f"signal {_signal_name(self)}: {_format_val(self._value)}")  # type: ignore[attr-defined]
        _original_trigger_cells(self)  # type: ignore[arg-type]

    Signal._trigger_cells = _trigger_cells_with_log  # type: ignore[assignment]

    try:
        yield log
    finally:
        Signal._trigger_cells = _original_trigger_cells  # type: ignore[assignment]


def _format_val(val: object) -> str:
    """格式化值用于日志。"""
    if isinstance(val, bool):
        return str(val)
    if isinstance(val, str):
        return repr(val)
    return str(val)

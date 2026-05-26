"""测试辅助工具：tree snapshot + event log。"""

from __future__ import annotations

import contextlib
import inspect
from collections.abc import Callable, Generator
from typing import Any

import diyui
from diyui import ScopeConfig, ScopeMode, ImmediateScheduler


# ══════════════════════════════════════════════════════════════════
# Shared Fake Components for Tests
# ══════════════════════════════════════════════════════════════════


class FakeMarkdown(diyui.ScopeNode):
    """Fake Markdown component with _tree_label."""

    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content

    def _tree_label(self) -> str:
        return f'Markdown "{self.content}"'


class FakeColumn(diyui.ScopeNode):
    """Fake Column container with context manager support."""

    def __init__(self) -> None:
        super().__init__()

    def __enter__(self) -> "FakeColumn":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

    def _tree_label(self) -> str:
        return "Column"


class FakeRow(diyui.ScopeNode):
    """Fake Row container with context manager support."""

    def __init__(self) -> None:
        super().__init__()

    def __enter__(self) -> "FakeRow":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

    def _tree_label(self) -> str:
        return "Row"


class FakeCard(diyui.ScopeNode):
    """Fake Card container with title and context manager support."""

    def __init__(self, title: str = "") -> None:
        super().__init__()
        self.title = title

    def __enter__(self) -> "FakeCard":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

    def _tree_label(self) -> str:
        base = "Card"
        return f'Card "{self.title}"' if self.title else base



class FakeApp(diyui.BaseApp):
    """测试用 App，继承 BaseApp，默认 ImmediateScheduler。

    提供 markdown/column/row/card 工厂方法。
    支持可选 config 参数（如 test_cell.py 需要）。
    """

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        if config is None:
            config = ScopeConfig(scheduler=ImmediateScheduler())
        super().__init__()
        self._config = config

    def _tree_label(self) -> str:
        return "App"

    def _add_to_current(self, child: diyui.ScopeNode) -> None:
        """将 child 添加到当前 context 节点，设置 _app。"""
        child._app = self
        if self._current.auto_mount_child:
            self._current._add_child(child)

    def signal(self, value: Any):
        """创建 Signal 并挂载到当前 _current 节点。"""
        node = self._current
        return diyui.ScopeNode.signal(node, value)

    def markdown(self, content: str) -> FakeMarkdown:
        md = FakeMarkdown(content)
        self._add_to_current(md)
        return md

    def column(self) -> FakeColumn:
        col = FakeColumn()
        col._app = self
        self._add_to_current(col)
        return col

    def row(self) -> FakeRow:
        r = FakeRow()
        r._app = self
        self._add_to_current(r)
        return r

    def card(self, title: str = "") -> FakeCard:
        card = FakeCard(title)
        card._app = self
        self._add_to_current(card)
        return card


# ══════════════════════════════════════════════════════════════════
# Tree Snapshot
# ══════════════════════════════════════════════════════════════════


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
    """获取 signal 的可读名称。

    依次从 owner class members、owner __dict__ 查找。
    """
    owner = getattr(sig, "owner", None)  # type: ignore[attr-defined]
    if owner is not None:
        # 优先使用显式设置的 _name
        if hasattr(sig, "_name"):  # type: ignore[attr-defined]
            return sig._name  # type: ignore[attr-defined]
        # 从 class members 找（property、descriptor 等）
        for name, val in inspect.getmembers(owner):
            if val is sig:
                return name
        # 从 instance __dict__ 找（直接赋值的属性）
        for name, val in owner.__dict__.items():
            if val is sig:
                return name
    return "signal"


# ══════════════════════════════════════════════════════════════════
# Event Log
# ══════════════════════════════════════════════════════════════════


class EventLog:
    """收集 scope tree 运行时事件。

    事件格式：
    - signal <name>: <old> → <new>
    - cell <label>: rerun start
    - cell <label>: rerun complete
    - cell <label>: error
    """

    def __init__(self) -> None:
        self._events: list[str] = []
        self._restore: list[Callable[[], None]] = []
        self._previous_signal_values: dict[int, object] = {}

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

    def __repr__(self) -> str:
        return f"EventLog({self._events})"

    def start(self) -> None:
        """激活事件收集（monkey-patch signal._trigger_cells 和 cell 执行）。"""
        import diyui._scope
        import diyui._debug
        import diyui._signal

        log = self

        # Hook signal._trigger_cells
        _original_trigger = diyui._signal.Signal._trigger_cells

        def _trigger_cells_with_log(sig: Any) -> None:
            sig_id = id(sig)
            old_val = log._previous_signal_values.get(sig_id, "?")
            old_val_str = _format_val(old_val)
            new_val_str = _format_val(sig._value)  # type: ignore[attr-defined]
            log.record(
                f"signal {_signal_name(sig)}: {old_val_str} → {new_val_str}"
            )
            log._previous_signal_values[sig_id] = sig._value  # type: ignore[attr-defined]
            _original_trigger(sig)

        diyui._signal.Signal._trigger_cells = _trigger_cells_with_log  # type: ignore[assignment]

        # Hook ScopeNode._execute_cell
        _original_execute = diyui._scope.ScopeNode._execute_cell

        def _execute_cell_with_log(self2: Any, *, initial: bool = False) -> None:
            log.record(f"cell {_node_label(self2)}: rerun start")
            try:
                _original_execute(self2, initial=initial)
            except Exception:
                log.record(f"cell {_node_label(self2)}: error")
                raise
            else:
                log.record(f"cell {_node_label(self2)}: rerun complete")

        diyui._scope.ScopeNode._execute_cell = _execute_cell_with_log  # type: ignore[assignment]

        # Hook generator cell
        _original_execute_gen = diyui._scope.ScopeNode._execute_cell_generator

        def _execute_cell_gen_with_log(self2: Any, *, initial: bool = False) -> None:
            log.record(f"cell {_node_label(self2)}: rerun start")
            try:
                _original_execute_gen(self2, initial=initial)
            except Exception:
                log.record(f"cell {_node_label(self2)}: error")
                raise
            else:
                log.record(f"cell {_node_label(self2)}: rerun complete")

        diyui._scope.ScopeNode._execute_cell_generator = _execute_cell_gen_with_log  # type: ignore[assignment]

        diyui._scope.ScopeNode._execute_cell_generator = _execute_cell_gen_with_log  # type: ignore[assignment]

        # Hook DebugInfo.record_error
        _original_record_error = diyui._debug.DebugInfo.record_error

        def _record_error_with_log(self2: Any, exc: Exception) -> None:
            log.record(f"cell {_node_label(self2._node)}: error")  # type: ignore[attr-defined]
            _original_record_error(self2, exc)

        diyui._debug.DebugInfo.record_error = _record_error_with_log  # type: ignore[assignment]

        self._restore = [
            lambda: setattr(diyui._signal.Signal, "_trigger_cells", _original_trigger),
            lambda: setattr(diyui._scope.ScopeNode, "_execute_cell", _original_execute),
            lambda: setattr(diyui._scope.ScopeNode, "_execute_cell_generator", _original_execute_gen),
            lambda: setattr(diyui._debug.DebugInfo, "record_error", _original_record_error),
        ]

    def stop(self) -> None:
        """停用事件收集，恢复原始方法。"""
        for restore_fn in self._restore:
            restore_fn()
        self._restore = []


@contextlib.contextmanager
def collect_events(
    app: diyui.BaseApp | None = None, log: EventLog | None = None
) -> Generator[EventLog, None, None]:
    """上下文管理器：收集 scope tree 运行时事件。

    通过 monkey-patch 记录 signal 变化和 cell rerun。
    """
    if log is None:
        log = EventLog()

    log.start()
    try:
        yield log
    finally:
        log.stop()


def _format_val(val: object) -> str:
    """格式化值用于日志。"""
    if isinstance(val, bool):
        return str(val)
    if isinstance(val, str):
        return repr(val)
    return str(val)

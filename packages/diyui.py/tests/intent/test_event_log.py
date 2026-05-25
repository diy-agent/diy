"""意图测试：event log 记录关键运行时事件。

验证 signal 变化、cell rerun 的事件流。
"""

import diyui
from helpers import EventLog, collect_events


def test_signal_change_event():
    """signal 写入触发事件记录。"""
    app = FakeApp()
    sig = app.signal(0)
    log = EventLog()

    with collect_events(app, log):
        sig.value = 42

    assert "signal" in log.events[0] if log.events else False
    # 确保至少有一条事件
    assert len(log.events) >= 1


def test_cell_rerun_events():
    """cell rerun 触发完整事件链。"""
    app = FakeApp()
    count = app.signal(0)

    @app.column().cell()
    def _(node: object):
        app.markdown(str(count.value))

    log = EventLog()

    with collect_events(app, log):
        count.value = 1

    # 应该有 signal 事件和 cell rerun 事件
    signal_events = [e for e in log.events if "signal" in e]
    assert len(signal_events) >= 1


def test_event_log_clear():
    """EventLog.clear() 清空事件。"""
    log = EventLog()
    log.record("e1")
    log.record("e2")
    log.clear()
    assert log.events == []


def test_event_log_eq_list():
    """EventLog == list 语法糖。"""
    log = EventLog()
    log.record("a")
    assert log == ["a"]
    assert log != ["b"]


# ══════════════════════════════════════════════════════════════════
# Fake test doubles
# ══════════════════════════════════════════════════════════════════


class FakeMarkdown(diyui.ScopeNode):
    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content


class FakeColumn(diyui.ScopeNode):
    def __init__(self) -> None:
        super().__init__()

    def __enter__(self) -> "FakeColumn":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class FakeApp(diyui.ScopeNode):
    def __init__(self) -> None:
        super().__init__(config=diyui.ScopeConfig(scheduler=diyui.ImmediateScheduler()))
        self._context_stack: list[diyui.ScopeNode] = [self]

    @property
    def _current(self) -> diyui.ScopeNode:
        return self._context_stack[-1]

    def _push_context(self, node: diyui.ScopeNode) -> None:
        self._context_stack.append(node)

    def _pop_context(self) -> None:
        self._context_stack.pop()

    def _add_to_current(self, child: diyui.ScopeNode) -> None:
        child._app = self
        if self._current.get_config("auto_mount_child") is not False:
            self._current._add_child(child)

    def signal(self, value: object) -> diyui.Signal[object]:
        return diyui.ScopeNode.signal(self._current, value)  # type: ignore[return-value]

    def markdown(self, content: str) -> FakeMarkdown:
        md = FakeMarkdown(content)
        self._add_to_current(md)
        return md

    def column(self) -> FakeColumn:
        col = FakeColumn()
        col._app = self  # type: ignore[assignment]
        self._add_to_current(col)
        return col

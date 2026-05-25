"""意图测试：signal 变化触发 cell rerun。

同时断言 tree_snapshot（运行时状态）和 event log（运行时事件流）。
"""

import diyui
from helpers import EventLog, collect_events, tree_snapshot


def test_signal_rerun_updates_children():
    """count 从 0→42 → cell rerun → markdown 内容更新 + rerun 计数 + 事件流。"""
    app = FakeApp()
    count = app.signal(0)
    log = EventLog()

    col = app.column()

    @col.cell()
    def _(node: object):
        app.markdown(str(count.value))

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=1]\n"
        '  FakeMarkdown "0"'
    )

    with collect_events(app, log):
        count.value = 42

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "42"'
    )
    assert len(log.events) == 1
    assert "42" in log.events[0]


def test_signal_rerun_changes_child_count():
    """count 1→3 → cell 产生 3 个 children + 事件流。"""
    app = FakeApp()
    count = app.signal(1)
    log = EventLog()

    col = app.column()

    @col.cell()
    def _(node: object):
        for i in range(count.value):
            app.markdown(f"item {i}")

    with collect_events(app, log):
        count.value = 3

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "item 0"\n'
        '  FakeMarkdown "item 1"\n'
        '  FakeMarkdown "item 2"'
    )
    assert len(log.events) == 1
    assert "3" in log.events[0]


def test_multiple_signal_changes():
    """同一 context 内多次 signal 变化 → 多条事件。"""
    app = FakeApp()
    a = app.signal(0)
    b = app.signal("x")
    log = EventLog()

    col = app.column()

    @col.cell()
    def _(node: object):
        _ = a.value, b.value

    with collect_events(app, log):
        a.value = 1
        b.value = "y"

    assert len(log.events) == 2
    assert any("1" in e for e in log.events)
    assert any("'y'" in e for e in log.events)


def test_failed_rerun_shows_error():
    """cell rerun 失败 → tree 显示 ERR + event log 有 signal 事件。"""
    app = FakeApp()
    fail = app.signal(False)
    value = app.signal("ok")
    log = EventLog()

    col = app.column()

    @col.cell()
    def _(node: object):
        if fail.value:
            raise RuntimeError("boom")
        app.markdown(value.value)

    assert "ERR" not in tree_snapshot(col)

    with collect_events(app, log):
        fail.value = True

    assert "ERR" in tree_snapshot(col)
    assert len(log.events) == 1
    assert "True" in log.events[0]


def test_generator_cell_tree_and_events():
    """生成器 cell：tree snapshot + event log 协同。"""
    app = FakeApp()
    count = app.signal(0)
    log = EventLog()

    col = app.column()

    @col.cell()
    def _(node: object):
        for i in range(count.value + 1):
            yield app.markdown(f"step {i}")

    with collect_events(app, log):
        count.value = 2

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "step 0"\n'
        '  FakeMarkdown "step 1"\n'
        '  FakeMarkdown "step 2"'
    )
    assert len(log.events) == 1
    assert "2" in log.events[0]


# ══════════════════════════════════════════════════════════════════
# Fake test doubles
# ══════════════════════════════════════════════════════════════════


class FakeMarkdown(diyui.ScopeNode):
    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content

    def _tree_label(self) -> str:
        return f'FakeMarkdown "{self.content}"'


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

    def _tree_label(self) -> str:
        return "FakeColumn"


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

    def _tree_label(self) -> str:
        return "FakeApp"

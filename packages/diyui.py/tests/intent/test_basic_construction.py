"""意图测试：基础树构建 + tree_snapshot 断言。"""

import diyui
from helpers import tree_snapshot


def test_empty_tree():
    app = FakeApp()
    assert tree_snapshot(app) == "FakeApp"


def test_column_with_markdown():
    app = FakeApp()
    with app.column():
        app.markdown("hello")
    assert tree_snapshot(app) == (
        "FakeApp\n"
        "  FakeColumn\n"
        '    FakeMarkdown "hello"'
    )


def test_nested_containers():
    app = FakeApp()
    with app.column() as outer:
        app.markdown("outer")
        with app.column() as inner:
            app.markdown("inner")
    assert tree_snapshot(app) == (
        "FakeApp\n"
        "  FakeColumn\n"
        '    FakeMarkdown "outer"\n'
        "    FakeColumn\n"
        '      FakeMarkdown "inner"'
    )


def test_signal_shown_in_tree():
    app = FakeApp()
    col = app.column()
    col.signal(42)
    assert "signal=42" in tree_snapshot(col)


def test_multiple_signals():
    app = FakeApp()
    col = app.column()
    col.signal(1)
    col.signal(2)
    label = tree_snapshot(col)
    assert "signal=1" in label
    assert "signal=2" in label


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

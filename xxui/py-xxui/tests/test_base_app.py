"""BaseApp API 契约测试。

BaseApp 是各 provider App 的基类，提供：
- with context 构建 parent-child 树
- app.signal() 创建 scope signal
- 上下文栈管理
"""

import pytest

from xxui.base_app import BaseApp
from xxui.scope import ScopeNode
from xxui.signal import Signal

# ═══════════════════════════════════════════════
# FakeApp：测试用最小 App
# ═══════════════════════════════════════════════


class FakeMarkdown(ScopeNode):
    """测试用 markdown 组件。"""

    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content


class FakeColumn(ScopeNode):
    """测试用容器组件，支持 with 语法。"""

    def __init__(self) -> None:
        super().__init__()
        # _app 类型已在 ScopeNode 中声明为 BaseApp | None

    def __enter__(self) -> "FakeColumn":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class FakeApp(BaseApp):
    """测试用 App，提供最小组件方法。"""

    def markdown(self, content: str) -> FakeMarkdown:
        md = FakeMarkdown(content)
        self._add_to_current(md)
        return md

    def column(self) -> FakeColumn:
        col = FakeColumn()
        col._app = self
        self._add_to_current(col)
        return col


# ═══════════════════════════════════════════════
# 构造
# ═══════════════════════════════════════════════


class TestBaseAppConstruction:
    """BaseApp / FakeApp 构造。"""

    def test_app_is_a_scope_node(self):
        app = FakeApp()
        assert isinstance(app, ScopeNode)

    def test_app_starts_with_no_children(self):
        app = FakeApp()
        assert app._children == []


# ═══════════════════════════════════════════════
# with context 构树
# ═══════════════════════════════════════════════


class TestWithContext:
    """with 语法构建 parent-child 树。"""

    def test_single_with_establishes_parent(self):
        app = FakeApp()
        with app.column() as col:
            md = app.markdown("hello")
        assert md.parent is col
        assert col.parent is app

    def test_children_are_in_order(self):
        app = FakeApp()
        with app.column() as col:
            a = app.markdown("a")
            b = app.markdown("b")
        assert col._children == [a, b]

    def test_nested_withs(self):
        app = FakeApp()
        with app.column() as outer:
            a = app.markdown("a")
            with app.column() as inner:
                b = app.markdown("b")
            c = app.markdown("c")
        assert outer._children == [a, inner, c]
        assert inner._children == [b]

    def test_context_restored_after_with(self):
        """退出 with 后，后续组件回到上层 context。"""
        app = FakeApp()
        with app.column():
            app.markdown("inner")
        md = app.markdown("outer")
        assert md.parent is app

    def test_app_level_components(self):
        """不在任何 with 内时，组件直接挂到 app 根。"""
        app = FakeApp()
        a = app.markdown("a")
        b = app.markdown("b")
        assert a.parent is app
        assert b.parent is app
        assert app._children == [a, b]


# ═══════════════════════════════════════════════
# app.signal()
# ═══════════════════════════════════════════════


class TestAppSignal:
    """app.signal() 创建带 scope 的 Signal。"""

    def test_signal_created_on_app_root(self):
        app = FakeApp()
        sig = app.signal(0)
        assert isinstance(sig, Signal)
        assert sig.owner is app
        assert sig.value == 0

    def test_signal_created_inside_with(self):
        """with 内创建的 signal 挂到当前 ScopeNode。"""
        app = FakeApp()
        with app.column() as col:
            sig = app.signal("inner")
        assert sig.owner is col

    def test_signal_value_is_readable(self):
        app = FakeApp()
        sig = app.signal(42)
        assert sig.value == 42

    def test_signal_value_is_writable(self):
        app = FakeApp()
        sig = app.signal(0)
        sig.value = 99
        assert sig.value == 99

    def test_signals_are_tracked_by_owner(self):
        app = FakeApp()
        a = app.signal(1)
        b = app.signal(2)
        assert app._signals == [a, b]


# ═══════════════════════════════════════════════
# 上下文栈
# ═══════════════════════════════════════════════


class TestContextStack:
    """BaseApp 内部上下文栈管理。"""

    def test_initial_current_is_app(self):
        app = FakeApp()
        assert app._current is app

    def test_push_and_pop(self):
        app = FakeApp()
        col = FakeColumn()
        col._app = app
        app._push_context(col)
        assert app._current is col
        app._pop_context()
        assert app._current is app

    def test_pop_on_empty_raises(self):
        """栈只剩 app 时不可再 pop。"""
        app = FakeApp()
        with pytest.raises(IndexError):
            app._pop_context()

"""Cell API 契约测试。

Cell 是 rerun 单位。普通函数不是 reactive component。
cell 函数接收当前 wrapper node 参数。定义时首次执行，依赖变化时自动 rerun。
"""
import pytest
from xxui.scope import ScopeNode, ScopeConfig
from xxui.scheduler import ImmediateScheduler


# ═══════════════════════════════════════════════
# 测试辅助
# ═══════════════════════════════════════════════

class FakeMarkdown(ScopeNode):
    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content


class FakeColumn(ScopeNode):
    """容器组件，支持 with 和 cell。"""

    def __init__(self) -> None:
        super().__init__()
        self._app: "FakeApp | None" = None

    def __enter__(self) -> "FakeColumn":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class FakeApp(ScopeNode):
    """测试用 App。默认 immediate scheduler。"""

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        if config is None:
            config = ScopeConfig(scheduler=ImmediateScheduler())
        super().__init__(config=config)
        self._context_stack: list[ScopeNode] = [self]

    @property
    def _current(self) -> ScopeNode:
        return self._context_stack[-1]

    def _push_context(self, node: ScopeNode) -> None:
        self._context_stack.append(node)

    def _pop_context(self) -> None:
        if len(self._context_stack) <= 1:
            raise IndexError("不能 pop 最后一个 context")
        self._context_stack.pop()

    def _add_to_current(self, child: ScopeNode) -> None:
        self._current._add_child(child)

    def signal(self, value):
        from xxui.signal import Signal
        sig = Signal(value)
        self._current._mount_signal(sig)
        return sig

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
# cell 基础
# ═══════════════════════════════════════════════

class TestCellBasics:
    """cell 定义时立即首次执行，接收 node 参数。"""

    def test_cell_executes_on_definition(self):
        app = FakeApp()
        executed = []

        @app.column().cell()
        def _(node):
            executed.append(node)

        assert len(executed) == 1
        assert executed[0] is not None

    def test_cell_receives_current_wrapper_node(self):
        app = FakeApp()
        seen = []

        col = app.column()

        @col.cell()
        def _(node):
            seen.append(node)

        assert seen[0] is col

    def test_cell_returns_wrapper(self):
        app = FakeApp()
        col = app.column()
        result = col.cell()(lambda n: None)
        assert result is col


# ═══════════════════════════════════════════════
# 依赖追踪
# ═══════════════════════════════════════════════

class TestCellDependencyTracking:
    """cell 执行时读取 signal.value 自动注册依赖。"""

    def test_cell_tracks_signal_dependency(self):
        app = FakeApp()
        count = app.signal(0)

        @app.column().cell()
        def _(node):
            app.markdown(str(count.value))

        assert len(count._cell_subscribers) == 1

    def test_multiple_signals_tracked(self):
        app = FakeApp()
        a = app.signal(1)
        b = app.signal(2)

        @app.column().cell()
        def _(node):
            app.markdown(str(a.value + b.value))

        assert len(a._cell_subscribers) == 1
        assert len(b._cell_subscribers) == 1

    def test_old_dependencies_cleared_on_rerun(self):
        """条件变化时，旧依赖被清理，新依赖重新收集。"""
        app = FakeApp()
        flag = app.signal(True)
        a = app.signal("a")
        b = app.signal("b")
        values = []

        @app.column().cell()
        def _(node):
            values.append(a.value if flag.value else b.value)

        # 初始：依赖 flag 和 a
        assert len(a._cell_subscribers) == 1
        assert len(b._cell_subscribers) == 0

        # 改变 flag，rerun 后依赖变为 flag 和 b
        flag.value = False

        assert values == ["a", "b"]
        assert len(a._cell_subscribers) == 0
        assert len(b._cell_subscribers) == 1


# ═══════════════════════════════════════════════
# signal 更新触发 rerun
# ═══════════════════════════════════════════════

class TestCellRerun:
    """signal 变化时自动 rerun 依赖 cell。"""

    def test_signal_update_reruns_dependent_cell(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node):
            calls.append(count.value)

        count.value = 1

        assert calls == [0, 1]

    def test_same_value_does_not_rerun(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node):
            calls.append(count.value)

        count.value = 0

        assert calls == [0]

    def test_multiple_updates(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node):
            calls.append(count.value)

        count.value = 1
        count.value = 2
        count.value = 3

        assert calls == [0, 1, 2, 3]

    def test_unrelated_signal_does_not_rerun(self):
        """未读取的 signal 变化不触发 rerun。"""
        app = FakeApp()
        a = app.signal("a")
        b = app.signal("b")
        calls = []

        @app.column().cell()
        def _(node):
            calls.append(a.value)

        b.value = "bb"

        assert calls == ["a"]


# ═══════════════════════════════════════════════
# staging：rerun 原子替换 children
# ═══════════════════════════════════════════════

class TestCellStaging:
    """cell rerun 时 staging 收集新 children，成功后原子替换。"""

    def test_rerun_replaces_children(self):
        app = FakeApp()
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node):
            app.markdown(str(count.value))

        assert len(col._children) == 1
        assert col._children[0].content == "0"

        count.value = 42

        assert len(col._children) == 1
        assert col._children[0].content == "42"

    def test_failed_rerun_keeps_old_children(self):
        app = FakeApp()
        value = app.signal("ok")
        fail = app.signal(False)

        col = app.column()

        @col.cell()
        def _(node):
            if fail.value:
                raise RuntimeError("bad")
            app.markdown(value.value)

        old_md = col._children[0]
        assert old_md.content == "ok"

        fail.value = True  # 触发 rerun，应该失败

        # 旧 children 保持不变
        assert col._children == [old_md]
        assert old_md.content == "ok"


# ═══════════════════════════════════════════════
# rerun 事务：防嵌套、写 signal enqueue
# ═══════════════════════════════════════════════

class TestCellTransaction:
    """rerun 中写 signal 只 enqueue，不嵌套执行。"""

    def test_signal_write_during_rerun_is_enqueued(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node):
            calls.append(count.value)
            if count.value == 1:
                count.value = 2  # rerun 中写 signal

        count.value = 1

        # 初始 0 → 变成 1 触发 rerun（读到 1，写 2）
        # → 2 的变化在 rerun 完成后 enqueue
        assert calls == [0, 1, 2]


# ═══════════════════════════════════════════════
# 普通函数不是 reactive
# ═══════════════════════════════════════════════

class TestPlainFunctionNotReactive:
    """普通 Python 函数不自动 rerun。只有 .cell() 标记的才响应。"""

    def test_plain_function_not_rerun(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        def header():
            calls.append("header")
            app.markdown("header")

        header()

        @app.column().cell()
        def _(node):
            app.markdown(str(count.value))

        count.value = 1

        # header 只执行一次（手动调用那次）
        assert calls == ["header"]


# ═══════════════════════════════════════════════
# 跨 scope signal 访问
# ═══════════════════════════════════════════════

class TestCrossScopeSignal:
    """子树外访问 signal：dev 报错。"""

    def test_cross_scope_read_raises_in_dev(self):
        from xxui.signal import ScopeViolationError
        app = FakeApp(config=ScopeConfig(mode="dev", scheduler=ImmediateScheduler()))

        with app.column() as left:
            secret = app.signal("left-secret")

        # right column 的 cell 读取 left column 的 signal → 跨 scope
        with pytest.raises(ScopeViolationError):
            with app.column() as right:

                @right.cell()
                def _(node):
                    _ = secret.value  # 跨 scope！

    def test_cross_scope_no_error_in_prod(self):
        """prod 模式不报错，但也不注册依赖。"""
        app = FakeApp(config=ScopeConfig(mode="prod", scheduler=ImmediateScheduler()))

        with app.column() as left:
            secret = app.signal("left-secret")

        # prod 模式不应该报错
        with app.column() as right:

            @right.cell()
            def _(node):
                _ = secret.value  # prod: 不报错

        # prod 下不注册依赖
        assert len(secret._cell_subscribers) == 0

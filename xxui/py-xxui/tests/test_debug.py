"""Debug API 契约测试。

Debug 是 scope 能力，提供：
- dev/prod mode 区分
- cell 执行错误捕获
- cell rerun 计数
- 跨 scope 访问警告
"""

from xxui.debug import DebugInfo
from xxui.scheduler import ImmediateScheduler
from xxui.scope import ScopeConfig, ScopeNode
from xxui.signal import Signal

# ═══════════════════════════════════════════════
# DebugInfo 基础
# ═══════════════════════════════════════════════


class TestDebugInfoBasics:
    """DebugInfo 记录 scope 运行时信息。"""

    def test_debug_info_attached_to_node(self):
        node = ScopeNode(config=ScopeConfig(mode="dev"))
        info = DebugInfo(node)
        assert info.mode == "dev"

    def test_mode_defaults_to_prod(self):
        node = ScopeNode()
        info = DebugInfo(node)
        # 无配置时 get_config 返回 None，debug 应视为 prod
        assert info.mode == "prod"

    def test_record_error(self):
        node = ScopeNode()
        info = DebugInfo(node)
        info.record_error(RuntimeError("bad"))
        assert info.has_error
        assert "bad" in info.last_error


# ═══════════════════════════════════════════════
# cell 执行错误捕获
# ═══════════════════════════════════════════════


class TestCellErrorCapture:
    """cell rerun 失败时错误被 debug 系统捕获。"""

    def test_cell_error_recorded_in_debug(self):
        from xxui.debug import get_debug

        class FakeApp(ScopeNode):
            def __init__(self):
                super().__init__(
                    config=ScopeConfig(
                        mode="dev",
                        scheduler=ImmediateScheduler(),
                    )
                )
                self._context_stack = [self]

            @property
            def _current(self):
                return self._context_stack[-1]

            def _push_context(self, node):
                self._context_stack.append(node)

            def _pop_context(self):
                if len(self._context_stack) <= 1:
                    raise IndexError
                self._context_stack.pop()

            def _add_to_current(self, child):
                child._app = self
                self._current._add_child(child)

            def signal(self, value):
                sig = Signal(value)
                self._current._mount_signal(sig)
                return sig

            def markdown(self, content):
                md = ScopeNode()
                self._add_to_current(md)
                return md

            def column(self):
                col = ScopeNode()
                col._app = self
                self._add_to_current(col)
                return col

        app = FakeApp()
        fail = app.signal(False)
        col = app.column()

        @col.cell()
        def _(node):
            if fail.value:
                raise RuntimeError("cell failed")

        # 第一次执行成功，无错误
        debug = get_debug(col)
        assert not debug.has_error

        # 触发失败 rerun
        fail.value = True

        assert debug.has_error
        assert "cell failed" in debug.last_error
        assert debug.rerun_count == 2  # 初始 1 + rerun 1


# ═══════════════════════════════════════════════
# rerun 计数
# ═══════════════════════════════════════════════


class TestRerunCount:
    """cell 每次执行增加 rerun_count。"""

    def test_rerun_count_increments(self):
        from xxui.debug import get_debug

        class FakeApp(ScopeNode):
            def __init__(self):
                super().__init__(
                    config=ScopeConfig(
                        mode="dev",
                        scheduler=ImmediateScheduler(),
                    )
                )
                self._context_stack = [self]

            @property
            def _current(self):
                return self._context_stack[-1]

            def _push_context(self, node):
                self._context_stack.append(node)

            def _pop_context(self):
                if len(self._context_stack) <= 1:
                    raise IndexError
                self._context_stack.pop()

            def _add_to_current(self, child):
                child._app = self
                self._current._add_child(child)

            def signal(self, value):
                sig = Signal(value)
                self._current._mount_signal(sig)
                return sig

            def markdown(self, content):
                md = ScopeNode()
                self._add_to_current(md)
                return md

            def column(self):
                col = ScopeNode()
                col._app = self
                self._add_to_current(col)
                return col

        app = FakeApp()
        count = app.signal(0)
        col = app.column()

        @col.cell()
        def _(node):
            app.markdown(str(count.value))

        debug = get_debug(col)
        assert debug.rerun_count == 1  # 初始执行

        count.value = 1
        assert debug.rerun_count == 2

        count.value = 2
        assert debug.rerun_count == 3

"""Debug API 契约测试。

Debug 是 scope 能力，提供：
- dev/prod mode 区分
- cell 执行错误捕获
- cell rerun 计数
- 跨 scope 访问警告
"""

from typing import Any

import diy.ui

# ═══════════════════════════════════════════════
# DebugInfo 基础
# ═══════════════════════════════════════════════


class TestDebugInfoBasics:
    """DebugInfo 记录 scope 运行时信息。"""

    def test_debug_info_attached_to_node(self):
        node = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV))
        info = diy.ui.DebugInfo(node)
        assert info.mode == diy.ui.ScopeMode.DEV

    def test_mode_defaults_to_prod(self):
        node = diy.ui.ScopeNode()
        info = diy.ui.DebugInfo(node)
        # 无配置时 mode 默认 PROD
        assert info.mode == diy.ui.ScopeMode.PROD

    def test_record_error(self):
        node = diy.ui.ScopeNode()
        info = diy.ui.DebugInfo(node)
        info.record_error(RuntimeError("bad"))
        assert info.has_error
        assert info.last_error is not None
        assert "bad" in info.last_error


# ═══════════════════════════════════════════════
# cell 执行错误捕获
# ═══════════════════════════════════════════════


class TestCellErrorCapture:
    """cell rerun 失败时错误被 debug 系统捕获。"""

    def test_cell_error_recorded_in_debug(self):
        class FakeApp(diy.ui.ScopeNode):
            def __init__(self):
                super().__init__(
                    config=diy.ui.ScopeConfig(
                        mode=diy.ui.ScopeMode.DEV,
                        scheduler=diy.ui.ImmediateScheduler(),
                    )
                )
                self._context_stack: list[diy.ui.ScopeNode] = [self]

            @property
            def _current(self):
                return self._context_stack[-1]

            def _push_context(self, node: diy.ui.ScopeNode):
                self._context_stack.append(node)
                return None

            def _pop_context(self, token: Any = None):
                if len(self._context_stack) <= 1:
                    raise IndexError
                self._context_stack.pop()

            def _add_to_current(self, child: diy.ui.ScopeNode):
                child._app = self  # type: ignore[assignment]
                self._current._add_child(child)

            def signal(self, value: Any):
                sig = diy.ui.Signal(value)
                self._current._mount_signal(sig)
                return sig

            def markdown(self, content: Any):
                md = diy.ui.ScopeNode()
                self._add_to_current(md)
                return md

            def column(self):
                col = diy.ui.ScopeNode()
                col._app = self  # type: ignore[assignment]
                self._add_to_current(col)
                return col

        app = FakeApp()
        fail = app.signal(False)
        col = app.column()

        @col.cell()
        def _(node: object):
            if fail.value:
                raise RuntimeError("cell failed")

        # 第一次执行成功，无错误
        debug = diy.ui.get_debug(col)
        assert not debug.has_error

        # 触发失败 rerun
        fail.value = True

        assert debug.has_error
        assert debug.last_error is not None
        assert "cell failed" in debug.last_error
        assert debug.rerun_count == 2  # 初始 1 + rerun 1


# ═══════════════════════════════════════════════
# rerun 计数
# ═══════════════════════════════════════════════


class TestRerunCount:
    """cell 每次执行增加 rerun_count。"""

    def test_rerun_count_increments(self):
        class FakeApp(diy.ui.ScopeNode):
            def __init__(self):
                super().__init__(
                    config=diy.ui.ScopeConfig(
                        mode=diy.ui.ScopeMode.DEV,
                        scheduler=diy.ui.ImmediateScheduler(),
                    )
                )
                self._context_stack: list[diy.ui.ScopeNode] = [self]

            @property
            def _current(self):
                return self._context_stack[-1]

            def _push_context(self, node: diy.ui.ScopeNode):
                self._context_stack.append(node)
                return None

            def _pop_context(self, token: Any = None):
                if len(self._context_stack) <= 1:
                    raise IndexError
                self._context_stack.pop()

            def _add_to_current(self, child: diy.ui.ScopeNode):
                child._app = self  # type: ignore[assignment]
                self._current._add_child(child)

            def signal(self, value: Any):
                sig = diy.ui.Signal(value)
                self._current._mount_signal(sig)
                return sig

            def markdown(self, content: Any):
                md = diy.ui.ScopeNode()
                self._add_to_current(md)
                return md

            def column(self):
                col = diy.ui.ScopeNode()
                col._app = self  # type: ignore[assignment]
                self._add_to_current(col)
                return col

        app = FakeApp()
        count = app.signal(0)
        col = app.column()

        @col.cell()
        def _(node: object):
            app.markdown(str(count.value))

        debug = diy.ui.get_debug(col)
        assert debug.rerun_count == 1  # 初始执行

        count.value = 1
        assert debug.rerun_count == 2

        count.value = 2
        assert debug.rerun_count == 3

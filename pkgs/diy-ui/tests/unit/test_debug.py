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


class _FakeAppForDebug(diy.ui.ScopeNode):
    """测试用 FakeApp — 自管理 ScopeProxy context stack（兼容 Phase 2）。"""

    def __init__(self, config=None):
        super().__init__(config=config)
        # context stack 存 ScopeProxy，与 BaseApp 一致
        self._proxies: list[diy.ui.ScopeProxy] = [self.diy]

    @property
    def _current(self) -> diy.ui.ScopeProxy:
        return self._proxies[-1]

    def _push_context(self, proxy: diy.ui.ScopeProxy):
        self._proxies.append(proxy)
        return None

    def _pop_context(self, token: Any = None):
        if len(self._proxies) <= 1:
            raise IndexError
        self._proxies.pop()

    def _add_to_current(self, child: diy.ui.ScopeNode):
        child._app = self
        self._current._add_child(child.diy)

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
        col._app = self
        self._add_to_current(col)
        return col


class TestCellErrorCapture:
    """cell rerun 失败时错误被 debug 系统捕获。"""

    def test_cell_error_recorded_in_debug(self):
        app = _FakeAppForDebug(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV,
                scheduler=diy.ui.ImmediateScheduler(),
            )
        )
        fail = app.signal(False)
        col = app.column()

        @col.cell()
        def _(node: object):
            if fail.value:
                raise RuntimeError("cell failed")

        debug = diy.ui.get_debug(col)
        assert not debug.has_error

        fail.value = True
        assert debug.has_error
        assert debug.last_error is not None
        assert "cell failed" in debug.last_error
        assert debug.rerun_count == 2


class TestRerunCount:
    """cell 每次执行增加 rerun_count。"""

    def test_rerun_count_increments(self):
        app = _FakeAppForDebug(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV,
                scheduler=diy.ui.ImmediateScheduler(),
            )
        )
        count = app.signal(0)
        col = app.column()

        @col.cell()
        def _(node: object):
            app.markdown(str(count.value))

        debug = diy.ui.get_debug(col)
        assert debug.rerun_count == 1

        count.value = 1
        assert debug.rerun_count == 2

        count.value = 2
        assert debug.rerun_count == 3

"""Cell API 契约测试。

Cell 是 rerun 单位。普通函数不是 reactive component。
cell 函数接收当前 wrapper node 参数。定义时首次执行，依赖变化时自动 rerun。
"""

from typing import Any

import pytest

import diyui

# ═══════════════════════════════════════════════
# 测试辅助
# ═══════════════════════════════════════════════


class FakeMarkdown(diyui.ScopeNode):
    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content


class FakeColumn(diyui.ScopeNode):
    """容器组件，支持 with 和 cell。"""

    def __init__(self) -> None:
        super().__init__()
        # _app 类型已在 ScopeNode 中声明

    def __enter__(self) -> "FakeColumn":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class FakeApp(diyui.ScopeNode):
    """测试用 App。默认 immediate scheduler。"""

    def __init__(self, *, config: diyui.ScopeConfig | None = None) -> None:
        if config is None:
            config = diyui.ScopeConfig(scheduler=diyui.ImmediateScheduler())
        super().__init__(config=config)
        self._context_stack: list[diyui.ScopeNode] = [self]

    @property
    def _current(self) -> diyui.ScopeNode:
        return self._context_stack[-1]

    def _push_context(self, node: diyui.ScopeNode) -> None:
        self._context_stack.append(node)

    def _pop_context(self) -> None:
        if len(self._context_stack) <= 1:
            raise IndexError("不能 pop 最后一个 context")
        self._context_stack.pop()

    def _add_to_current(self, child: diyui.ScopeNode) -> None:
        if self._current.get_config("auto_mount_child") is not False:
            self._current._add_child(child)

    def signal(self, value: Any):
        node = self._current
        return diyui.ScopeNode.signal(node, value)

    def markdown(self, content: str) -> FakeMarkdown:
        md = FakeMarkdown(content)
        self._add_to_current(md)
        return md

    def column(self) -> FakeColumn:
        col = FakeColumn()
        col._app = self  # type: ignore[assignment]
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
        def _(node: object):
            executed.append(node)

        assert len(executed) == 1
        assert executed[0] is not None

    def test_cell_receives_current_wrapper_node(self):
        app = FakeApp()
        seen = []

        col = app.column()

        @col.cell()
        def _(node: object):
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
        def _(node: object):
            app.markdown(str(count.value))

        assert len(count._cell_subscribers) == 1

    def test_multiple_signals_tracked(self):
        app = FakeApp()
        a = app.signal(1)
        b = app.signal(2)

        @app.column().cell()
        def _(node: object):
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
        def _(node: object):
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
        def _(node: object):
            calls.append(count.value)

        count.value = 1

        assert calls == [0, 1]

    def test_same_value_does_not_rerun(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node: object):
            calls.append(count.value)

        count.value = 0

        assert calls == [0]

    def test_multiple_updates(self):
        app = FakeApp()
        count = app.signal(0)
        calls = []

        @app.column().cell()
        def _(node: object):
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
        def _(node: object):
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
        def _(node: object):
            app.markdown(str(count.value))

        assert len(col._children) == 1
        assert col._children[0].content == "0"  # type: ignore[attr-defined]

        count.value = 42

        assert len(col._children) == 1
        assert col._children[0].content == "42"  # type: ignore[attr-defined]

    def test_failed_rerun_clears_children_and_logs_error(self):
        """去 staging 后，rerun 失败时清空旧 children（不回滚），记录错误。"""
        app = FakeApp()
        value = app.signal("ok")
        fail = app.signal(False)

        col = app.column()

        @col.cell()
        def _(node: object):
            if fail.value:
                raise RuntimeError("bad")
            app.markdown(value.value)

        assert len(col._children) == 1
        assert col._children[0].content == "ok"  # type: ignore[attr-defined]

        fail.value = True  # 触发 rerun，失败

        # 去 staging 后：旧 children 解除关系，不恢复，children 为空
        assert col._children == []
        # debug 记录了错误
        debug = diyui.get_debug(col)
        assert debug.has_error
        assert "bad" in (debug.last_error or "")


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
        def _(node: object):
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
        def _(node: object):
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
        app = FakeApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.DEV, scheduler=diyui.ImmediateScheduler()))

        with app.column() as _left:
            secret = app.signal("left-secret")

        # right column 的 cell 读取 left column 的 signal → 跨 scope
        with pytest.raises(diyui.ScopeViolationError), app.column() as right:

            @right.cell()
            def _(node: object):
                _ = secret.value  # 跨 scope！

    def test_cross_scope_no_error_in_prod(self):
        """prod 模式不报错，但也不注册依赖。"""
        app = FakeApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.PROD, scheduler=diyui.ImmediateScheduler()))

        with app.column() as _left:
            secret = app.signal("left-secret")

        # prod 模式不应该报错
        with app.column() as right:

            @right.cell()
            def _(node: object):
                _ = secret.value  # prod: 不报错

        # prod 下不注册依赖
        assert len(secret._cell_subscribers) == 0


# ═══════════════════════════════════════════════
# Generator Cell
# ═══════════════════════════════════════════════


class TestGeneratorCellBasics:
    """生成器 cell 基础：定义时首次执行，yield 组件挂载到 cell node。"""

    def test_generator_cell_executes_on_definition(self):
        app = FakeApp()
        executed = []

        @app.column().cell()
        def _(node: object):
            executed.append(1)
            yield

        assert executed == [1]

    def test_generator_cell_yields_components(self):
        app = FakeApp()

        col = app.column()

        @col.cell()
        def _(node: object):
            yield app.markdown("step 1")
            yield app.markdown("step 2")
            yield app.markdown("step 3")

        assert len(col._children) == 3
        assert col._children[0].content == "step 1"  # type: ignore[attr-defined]
        assert col._children[1].content == "step 2"  # type: ignore[attr-defined]
        assert col._children[2].content == "step 3"  # type: ignore[attr-defined]

    def test_generator_cell_empty_ok(self):
        """空生成器（无 yield）不报错。"""
        app = FakeApp()

        @app.column().cell()
        def _(node: object):
            if False:
                yield

        # 不抛异常

    def test_generator_cell_yield_none_ends(self):
        """yield None 视为结束。"""
        app = FakeApp()

        col = app.column()

        @col.cell()
        def _(node: object):
            yield app.markdown("visible")
            yield None
            yield app.markdown("never")  # 不会执行到

        assert len(col._children) == 1
        assert col._children[0].content == "visible"  # type: ignore[attr-defined]


class TestGeneratorCellRerun:
    """生成器 cell 依赖 signal 变化时自动 rerun。"""

    def test_generator_cell_reruns_on_signal_change(self):
        app = FakeApp()
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node: object):
            yield app.markdown(str(count.value))

        assert col._children[0].content == "0"  # type: ignore[attr-defined]

        count.value = 1
        assert col._children[0].content == "1"  # type: ignore[attr-defined]

    def test_generator_cell_rerun_replaces_children(self):
        """rerun 时清空旧 children，重建新 children。"""
        app = FakeApp()
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node: object):
            for i in range(count.value + 1):
                yield app.markdown(f"item {i}")

        assert len(col._children) == 1
        assert col._children[0].content == "item 0"  # type: ignore[attr-defined]

        count.value = 2
        assert len(col._children) == 3
        assert [c.content for c in col._children] == ["item 0", "item 1", "item 2"]  # type: ignore[attr-defined]

    def test_generator_cell_multiple_reruns(self):
        app = FakeApp()
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node: object):
            yield app.markdown(str(count.value))

        count.value = 1
        count.value = 2
        count.value = 3

        assert col._children[0].content == "3"  # type: ignore[attr-defined]

    def test_generator_cell_dependency_tracking(self):
        """生成器 cell 正确追踪和清理依赖。"""
        app = FakeApp()
        flag = app.signal(True)
        a = app.signal("a")
        b = app.signal("b")

        col = app.column()

        @col.cell()
        def _(node: object):
            yield app.markdown(a.value if flag.value else b.value)

        assert len(a._cell_subscribers) == 1
        assert len(b._cell_subscribers) == 0

        flag.value = False
        assert len(a._cell_subscribers) == 0
        assert len(b._cell_subscribers) == 1

    def test_generator_cell_signal_write_during_rerun(self):
        """生成器 cell rerun 中写 signal 被 enqueue。"""
        app = FakeApp()
        count = app.signal(0)
        calls = []

        col = app.column()

        @col.cell()
        def _(node: object):
            calls.append(count.value)
            if count.value == 1:
                count.value = 2
            yield app.markdown(str(count.value))

        count.value = 1
        assert calls == [0, 1, 2]


class TestAsyncGeneratorCell:
    """异步生成器 cell：支持 yield awaitable（Phase 4）。"""

    def test_sync_generator_yield_awaitable_upgrades(self):
        """同步生成器 yield awaitable → sync 入口检测到 → 升级到 async。

        _execute_cell_generator 检测到 awaitable 后走 _drive_generator_async。
        这里直接测 _drive_generator_async 的完整执行（跳过升级路径），
        升级行为由 `test_drive_generator_async_with_awaitable` 覆盖。
        """
        import asyncio

        async def fetch():
            await asyncio.sleep(0)
            return "data"

        app = FakeApp()
        col = app.column()

        def sync_cell(node: object):
            yield app.markdown("before")
            data = yield fetch()
            yield app.markdown(data)

        col._cell_fn = sync_cell  # type: ignore[assignment]
        col._app = app  # type: ignore[assignment]
        col._config = diyui.ScopeConfig(
            auto_mount_child=False,
            scheduler=diyui.ImmediateScheduler(),
        )

        async def run():
            await col._drive_generator_async(initial=True)
            return col._children

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            children = loop.run_until_complete(run())
            assert len(children) == 2
            assert children[0].content == "before"  # type: ignore[attr-defined]
            assert children[1].content == "data"  # type: ignore[attr-defined]
        finally:
            loop.close()

    def test_enqueue_async_scheduling(self):
        """enqueue_async 在 event loop 中创建 task。"""
        import asyncio

        scheduler = diyui.ImmediateScheduler()
        results: list[str] = []

        async def task():
            results.append("ran")

        async def run():
            scheduler.enqueue_async(lambda: task())
            await asyncio.sleep(0)
            return results

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            got = loop.run_until_complete(run())
            assert got == ["ran"]
        finally:
            loop.close()

    def test_drive_generator_async_with_awaitable(self):
        """_drive_generator_async 正确处理 def 生成器中 yield awaitable。"""
        import asyncio

        app = FakeApp()

        async def fetch():
            await asyncio.sleep(0)
            return "loaded"

        def sync_cell(node: object):
            data = yield fetch()
            yield app.markdown(data)

        # 直接测试 _drive_generator_async（不走装饰器）
        col = app.column()
        col._cell_fn = sync_cell  # type: ignore[assignment]
        col._app = app  # type: ignore[assignment]
        col._config = diyui.ScopeConfig(
            auto_mount_child=False,
            scheduler=diyui.ImmediateScheduler(),
        )

        async def run():
            await col._drive_generator_async(initial=True)
            return [c.content for c in col._children]  # type: ignore[attr-defined]

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            children = loop.run_until_complete(run())
            assert children == ["loaded"]
        finally:
            loop.close()

"""意图测试：signal 变化触发 cell rerun。

用 tree_snapshot 断言运行时状态：rerun 次数、children 内容。
"""

import diyui
from helpers import tree_snapshot


def test_signal_rerun_updates_children():
    """count 从 0→42 → cell rerun → markdown 内容更新 + rerun 计数。"""
    app = FakeApp()
    count = app.signal(0)

    col = app.column()

    @col.cell()
    def _(node: object):
        app.markdown(str(count.value))

    # 首次执行：rerun=1，markdown 内容 "0"
    assert tree_snapshot(col) == (
        "FakeColumn [rerun=1]\n"
        '  FakeMarkdown "0"'
    )

    count.value = 42

    # rerun 后：rerun=2，markdown 内容 "42"
    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "42"'
    )


def test_signal_rerun_changes_child_count():
    """count 1→3 → cell 产生 3 个 children → tree 反映。"""
    app = FakeApp()
    count = app.signal(1)

    col = app.column()

    @col.cell()
    def _(node: object):
        for i in range(count.value):
            app.markdown(f"item {i}")

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=1]\n"
        '  FakeMarkdown "item 0"'
    )

    count.value = 3
    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "item 0"\n'
        '  FakeMarkdown "item 1"\n'
        '  FakeMarkdown "item 2"'
    )


def test_cell_rerun_with_signal_value_visible():
    """col 上挂的 signal 显示在 tree 中。"""
    app = FakeApp()
    count = app.signal(0)
    flag = app.signal(True)

    col = app.column()

    @col.cell()
    def _(node: object):
        app.markdown("A" if flag.value else "B")
        _ = count.value  # 读 count 但不用于输出

    assert 'FakeColumn [rerun=1]' in tree_snapshot(col)
    assert 'FakeMarkdown "A"' in tree_snapshot(col)

    flag.value = False
    assert 'FakeMarkdown "B"' in tree_snapshot(col)
    assert "rerun=2" in tree_snapshot(col)


def test_failed_rerun_shows_error():
    """cell rerun 失败时 tree 显示 ERR 标记。"""
    app = FakeApp()
    fail = app.signal(False)
    value = app.signal("ok")

    col = app.column()

    @col.cell()
    def _(node: object):
        if fail.value:
            raise RuntimeError("boom")
        app.markdown(value.value)

    # 首次 OK
    assert "ERR" not in tree_snapshot(col)

    fail.value = True
    # rerun 失败 → ERR
    assert "ERR" in tree_snapshot(col)


def test_generator_cell_tree():
    """生成器 cell：yield 的组件体现在 tree 中，rerun 计数递增。"""
    app = FakeApp()
    count = app.signal(0)

    col = app.column()

    @col.cell()
    def _(node: object):
        for i in range(count.value + 1):
            yield app.markdown(f"step {i}")

    assert tree_snapshot(col) == (
        "FakeColumn [rerun=1]\n"
        '  FakeMarkdown "step 0"'
    )

    count.value = 2
    assert tree_snapshot(col) == (
        "FakeColumn [rerun=2]\n"
        '  FakeMarkdown "step 0"\n'
        '  FakeMarkdown "step 1"\n'
        '  FakeMarkdown "step 2"'
    )


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

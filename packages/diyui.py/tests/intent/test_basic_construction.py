"""意图测试：基础树构建 — 树状态快照。

表达"用 with 语法构建 UI 树后，树长什么样"。
这些测试不涉及 rerun，只验证静态树结构的正确性。

意图：让人类看一眼 tree_snapshot 输出就理解系统做了什么。
"""

import diyui
from helpers import tree_snapshot


# ══════════════════════════════════════════════════════════════════
# Shared Fake Components
# ══════════════════════════════════════════════════════════════════


class FakeMarkdown(diyui.ScopeNode):
    def __init__(self, content: str) -> None:
        super().__init__()
        self.content = content

    def _tree_label(self) -> str:
        return f'Markdown "{self.content}"'


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
        return "Column"


class FakeRow(diyui.ScopeNode):
    def __init__(self) -> None:
        super().__init__()

    def __enter__(self) -> "FakeRow":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

    def _tree_label(self) -> str:
        return "Row"


class FakeCard(diyui.ScopeNode):
    def __init__(self, title: str = "") -> None:
        super().__init__()
        self.title = title

    def __enter__(self) -> "FakeCard":
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

    def _tree_label(self) -> str:
        base = "Card"
        return f'{base} "{self.title}"' if self.title else base


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

    def row(self) -> FakeRow:
        row = FakeRow()
        row._app = self  # type: ignore[assignment]
        self._add_to_current(row)
        return row

    def card(self, title: str = "") -> FakeCard:
        card = FakeCard(title)
        card._app = self  # type: ignore[assignment]
        self._add_to_current(card)
        return card

    def _tree_label(self) -> str:
        return "App"


# ══════════════════════════════════════════════════════════════════
# 意图测试：树构建
# ══════════════════════════════════════════════════════════════════


def test_empty_app():
    """刚创建的 app 是一棵只有根的空树。"""
    app = FakeApp()
    assert tree_snapshot(app) == "App"


def test_two_components_on_root():
    """两个组件直接挂到 app 根上，按创建顺序排列。"""
    app = FakeApp()
    app.markdown("# 标题")
    app.markdown("正文")

    assert tree_snapshot(app) == (
        "App\n"
        '  Markdown "# 标题"\n'
        '  Markdown "正文"'
    )


def test_column_with_children():
    """with column 内的组件成为 column 的子节点。"""
    app = FakeApp()
    with app.column():
        app.markdown("第1行")
        app.markdown("第2行")

    assert tree_snapshot(app) == (
        "App\n"
        "  Column\n"
        '    Markdown "第1行"\n'
        '    Markdown "第2行"'
    )


def test_nested_containers():
    """嵌套 with：树结构反映代码缩进层级。"""
    app = FakeApp()
    with app.column():
        app.markdown("外层")
        with app.row():
            app.markdown("里层 A")
            app.markdown("里层 B")
        app.markdown("外层底部")

    assert tree_snapshot(app) == (
        "App\n"
        "  Column\n"
        '    Markdown "外层"\n'
        "    Row\n"
        '      Markdown "里层 A"\n'
        '      Markdown "里层 B"\n'
        '    Markdown "外层底部"'
    )


def test_card_with_title():
    """Card 容器显示标题。"""
    app = FakeApp()
    with app.card(title="设置"):
        app.markdown("选项 1")

    assert tree_snapshot(app) == (
        "App\n"
        '  Card "设置"\n'
        '    Markdown "选项 1"'
    )


def test_signal_mounted_on_owner():
    """app.signal() 创建的 signal 显示在 owner 节点上。"""
    app = FakeApp()
    col = app.column()
    col.signal(42)

    assert "signal=42" in tree_snapshot(col)


def test_context_restored_after_with():
    """退出 with 后，后续组件回到上层。"""
    app = FakeApp()
    with app.column():
        app.markdown("col 内")
    app.markdown("col 外 — 回到 app")

    assert tree_snapshot(app) == (
        "App\n"
        "  Column\n"
        '    Markdown "col 内"\n'
        '  Markdown "col 外 — 回到 app"'
    )


def test_many_children():
    """大量 children 时树保持清晰。"""
    app = FakeApp()
    with app.column():
        for i in range(5):
            app.markdown(f"item {i}")

    assert tree_snapshot(app) == (
        "App\n"
        "  Column\n"
        '    Markdown "item 0"\n'
        '    Markdown "item 1"\n'
        '    Markdown "item 2"\n'
        '    Markdown "item 3"\n'
        '    Markdown "item 4"'
    )

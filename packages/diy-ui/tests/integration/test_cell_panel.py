"""Cell Panel 集成测试 — 使用 Panel provider。"""

import diyui
import diyui.providers.panel as diypn


class TestGeneratorCellWithPanel:
    """生成器 cell 在 Panel provider 下的集成测试。"""

    def test_generator_cell_yields_panel_components(self):
        app = diypn.PanelApp(
            config=diyui.ScopeConfig(
                mode=diyui.ScopeMode.DEV,
                scheduler=diyui.ImmediateScheduler(),
            )
        )

        col = app.layout.column()

        @col.cell()
        def _(node: object):
            yield app.pane.markdown("## Step 1")
            yield app.pane.markdown("## Step 2")

        assert len(col._children) == 2
        assert col._children[0].object == "## Step 1"  # type: ignore[attr-defined]
        assert col._children[1].object == "## Step 2"  # type: ignore[attr-defined]

    def test_generator_cell_rerun_panel(self):
        app = diypn.PanelApp(
            config=diyui.ScopeConfig(
                mode=diyui.ScopeMode.DEV,
                scheduler=diyui.ImmediateScheduler(),
            )
        )
        count = app.signal(1)

        col = app.layout.column()

        @col.cell()
        def _(node: object):
            for i in range(count.value):
                yield app.pane.markdown(f"item {i}")

        assert len(col._children) == 1

        count.value = 3
        assert len(col._children) == 3
        assert col._children[2].object == "item 2"  # type: ignore[attr-defined]

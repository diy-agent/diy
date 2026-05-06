"""Panel provider 契约测试。

PanelApp 是 Panel 专属的 xxui App。
组件是 Panel 原生组件的薄包装，参数保持 Panel 风格。
"""
import panel as pn
from xxui.providers.panel import (
    PanelApp,
    PanelColumn, PanelRow, PanelCard,
    PanelButton, PanelTextInput, PanelRadioButtonGroup, PanelMarkdown,
)


# ═══════════════════════════════════════════════
# 构造与入口
# ═══════════════════════════════════════════════

class TestPanelAppConstruction:
    """PanelApp 构造与 provider 标识。"""

    def test_create_panel_app(self):
        app = PanelApp()
        assert app.provider == "panel"

    def test_app_is_base_app(self):
        from xxui.base_app import BaseApp
        app = PanelApp()
        assert isinstance(app, BaseApp)


# ═══════════════════════════════════════════════
# 组件参数保持 Panel 风格
# ═══════════════════════════════════════════════

class TestComponentPanelStyle:
    """组件参数与 Panel 原生保持一致。"""

    def test_button_keeps_panel_params(self):
        app = PanelApp()
        btn = app.button(name="Run", button_type="primary")
        assert btn.target.name == "Run"
        assert btn.target.button_type == "primary"

    def test_text_input_keeps_panel_params(self):
        app = PanelApp()
        inp = app.text_input(name="Name", placeholder="input name")
        assert inp.target.name == "Name"
        assert inp.target.placeholder == "input name"

    def test_radio_button_group_keeps_panel_params(self):
        app = PanelApp()
        radio = app.radio_button_group(options=["a", "b", "c"])
        assert radio.target.options == ["a", "b", "c"]

    def test_markdown_keeps_panel_params(self):
        app = PanelApp()
        md = app.markdown("# Title")
        assert "# Title" in str(md.target.object)


# ═══════════════════════════════════════════════
# with context 构建 Panel 树
# ═══════════════════════════════════════════════

class TestWithContextPanelTree:
    """with 语法在 Panel 容器中构建父子关系。"""

    def test_column_contains_button(self):
        app = PanelApp()
        with app.column() as col:
            btn = app.button(name="Run")
        assert btn.parent is col
        assert btn in col._children

    def test_nested_panel_containers(self):
        app = PanelApp()
        with app.column() as outer:
            md1 = app.markdown("outer")
            with app.row() as inner:
                btn = app.button(name="Go")
            md2 = app.markdown("after")
        assert outer._children == [md1, inner, md2]
        assert inner._children == [btn]

    def test_card_as_container(self):
        app = PanelApp()
        with app.card(title="My Card") as card:
            btn = app.button(name="OK")
        assert btn.parent is card
        assert btn in card._children
        assert card.target.title == "My Card"


# ═══════════════════════════════════════════════
# 输入组件 value ↔ signal
# ═══════════════════════════════════════════════

class TestInputComponentSignal:
    """输入组件的 .value 代理到 signal.value。"""

    def test_text_input_value_reads_signal(self):
        app = PanelApp()
        inp = app.text_input(name="Name", value="Alice")
        assert inp.value == "Alice"
        assert inp.signal.value == "Alice"

    def test_text_input_value_writes_signal_and_target(self):
        app = PanelApp()
        inp = app.text_input(name="Name", value="Alice")
        inp.value = "Bob"
        assert inp.signal.value == "Bob"
        assert inp.target.value == "Bob"

    def test_radio_button_group_value(self):
        app = PanelApp()
        radio = app.radio_button_group(options=["a", "b"], value="a")
        assert radio.value == "a"
        radio.value = "b"
        assert radio.signal.value == "b"
        assert radio.target.value == "b"


# ═══════════════════════════════════════════════
# wrapper 公开 native target
# ═══════════════════════════════════════════════

class TestWrapperExposesTarget:
    """xxui 是薄层，用户可直接访问 .target。"""

    def test_button_exposes_target(self):
        app = PanelApp()
        btn = app.button(name="Run")
        assert isinstance(btn.target, pn.widgets.Button)

    def test_markdown_exposes_target(self):
        app = PanelApp()
        md = app.markdown("hi")
        assert isinstance(md.target, pn.pane.Markdown)

    def test_column_exposes_target(self):
        app = PanelApp()
        col = app.column()
        assert isinstance(col.target, pn.Column)


# ═══════════════════════════════════════════════
# app.signal() 在 Panel context 中
# ═══════════════════════════════════════════════

class TestPanelAppSignal:
    """app.signal() 创建 scope signal 并参与 cell rerun。"""

    def test_signal_inside_panel_container(self):
        from xxui.signal import Signal
        app = PanelApp()
        with app.column() as col:
            sig = app.signal(42)
        assert isinstance(sig, Signal)
        assert sig.owner is col

    def test_cell_with_panel_components(self):
        """cell 内使用 Panel 组件，signal 变化时 rerun。"""
        from xxui.scheduler import ImmediateScheduler
        from xxui.scope import ScopeConfig
        app = PanelApp(config=ScopeConfig(
            mode="dev",
            scheduler=ImmediateScheduler(),
        ))
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node):
            app.markdown(str(count.value))

        assert col._children[0].target.object == "0"

        count.value = 42

        assert col._children[0].target.object == "42"


# ═══════════════════════════════════════════════
# servable
# ═══════════════════════════════════════════════

class TestPanelServable:
    """servable() 找到首个实际 Panel 组件并调用 .servable()。"""

    def test_servable_returns_servable_object(self):
        app = PanelApp()
        app.markdown("# Title")
        result = app.servable()
        assert result is not None

    def test_servable_works_with_nested_containers(self):
        app = PanelApp()
        with app.column():
            app.button(name="Run")
        result = app.servable()
        assert result is not None

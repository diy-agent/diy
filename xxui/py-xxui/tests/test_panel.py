"""Panel provider 契约测试。

PanelApp 是 Panel 专属的 xxui App。
组件是 Panel 原生组件的薄包装，参数保持 Panel 风格。
"""

import panel as pn

from xxui.providers.panel import (
    PanelApp,
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
        assert btn.name == "Run"
        assert btn.button_type == "primary"

    def test_text_input_keeps_panel_params(self):
        app = PanelApp()
        inp = app.text_input(name="Name", placeholder="input name")
        assert inp.name == "Name"
        assert inp.placeholder == "input name"

    def test_radio_button_group_keeps_panel_params(self):
        app = PanelApp()
        radio = app.radio_button_group(options=["a", "b", "c"])
        assert radio.options == ["a", "b", "c"]

    def test_markdown_keeps_panel_params(self):
        app = PanelApp()
        md = app.markdown("# Title")
        assert "# Title" in str(md.object)


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
        assert card.title == "My Card"


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
        """通过 wrapper.value 写入时，signal 和 Panel 原生值同步更新。"""
        app = PanelApp()
        inp = app.text_input(name="Name", value="Alice")
        inp.value = "Bob"
        assert inp.signal.value == "Bob"
        assert inp.value == "Bob"
        # 验证 Panel 原生 param 值也同步（通过 descriptor __get__ 绕过 property）
        pv = inp.param["value"].__get__(inp, type(inp))
        assert pv == "Bob"

    def test_text_input_panel_native_value_sync(self):
        """通过 Panel param 模拟用户输入，signal.value 应同步。"""
        app = PanelApp()
        inp = app.text_input(name="Name", value="Alice")
        # 模拟 Panel 用户输入事件
        inp.param.update(value="Charlie")
        assert inp.signal.value == "Charlie"
        assert inp.value == "Charlie"

    def test_radio_button_group_value(self):
        app = PanelApp()
        radio = app.radio_button_group(options=["a", "b"], value="a")
        assert radio.value == "a"
        radio.value = "b"
        assert radio.signal.value == "b"
        assert radio.value == "b"
        # 验证 Panel 原生 param 值也同步
        pv = radio.param["value"].__get__(radio, type(radio))
        assert pv == "b"


# ═══════════════════════════════════════════════
# wrapper 公开 native target
# ═══════════════════════════════════════════════


class TestWrapperExposesTarget:
    """xxui 是薄层，用户可直接访问 .target（向后兼容，self 就是 provider 原生对象）。"""

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
# 组件即 Panel 原生实例（继承验证）
# ═══════════════════════════════════════════════


class TestComponentIsPanelNative:
    """xxui 组件继承 Panel 原生类，可直接当 Panel 组件使用。"""

    def test_button_is_panel_button(self):
        app = PanelApp()
        btn = app.button(name="Run")
        assert isinstance(btn, pn.widgets.Button)
        assert btn.name == "Run"  # Panel param 直接可访问

    def test_text_input_is_panel_text_input(self):
        app = PanelApp()
        inp = app.text_input(name="Name", value="Alice")
        assert isinstance(inp, pn.widgets.TextInput)

    def test_radio_button_group_is_panel_radio(self):
        app = PanelApp()
        radio = app.radio_button_group(options=["a", "b"])
        assert isinstance(radio, pn.widgets.RadioButtonGroup)

    def test_markdown_is_panel_markdown(self):
        app = PanelApp()
        md = app.markdown("hi")
        assert isinstance(md, pn.pane.Markdown)

    def test_column_is_panel_column(self):
        app = PanelApp()
        col = app.column()
        assert isinstance(col, pn.Column)

    def test_row_is_panel_row(self):
        app = PanelApp()
        row = app.row()
        assert isinstance(row, pn.Row)

    def test_card_is_panel_card(self):
        app = PanelApp()
        card = app.card(title="T")
        assert isinstance(card, pn.Card)


class TestPanelNativeApiDirectAccess:
    """无需 .target 即可直接访问 Panel 原生 API。"""

    def test_button_on_click_works_directly(self):
        app = PanelApp()
        btn = app.button(name="Run")
        calls = []
        btn.on_click(lambda e: calls.append(1))
        assert btn.clicks == 0
        # on_click 已注册，验证无异常
        assert hasattr(btn, "on_click")

    def test_button_clicks_directly(self):
        app = PanelApp()
        btn = app.button(name="Run")
        assert btn.clicks == 0

    def test_target_is_self_for_backward_compat(self):
        app = PanelApp()
        btn = app.button(name="Run")
        assert btn.target is btn

    def test_text_input_param_watch_directly(self):
        app = PanelApp()
        inp = app.text_input(value="hello")
        # param.watch 直接可用（无 .target）
        assert hasattr(inp.param, "watch")


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

        app = PanelApp(
            config=ScopeConfig(
                mode="dev",
                scheduler=ImmediateScheduler(),
            )
        )
        count = app.signal(0)

        col = app.column()

        @col.cell()
        def _(node):
            app.markdown(str(count.value))

        assert col._children[0].object == "0"

        count.value = 42

        assert col._children[0].object == "42"


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

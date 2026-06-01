"""Input 组件演示 — 文本/数字输入"""
import numpy as np
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.DEV, scheduler=diyui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Input 组件")

    app.pane.markdown("## TextInput")
    app.widgets.text_input(value="Hello World", name="Name")

    app.pane.markdown("## TextAreaInput")
    app.widgets.text_area_input(value="Line 1\nLine 2\nLine 3", name="Message")

    app.pane.markdown("## PasswordInput")
    app.widgets.password_input(value="secret123", name="Password")

    app.pane.markdown("## LiteralInput (任意类型)")
    app.widgets.literal_input(value={"key": "value"}, name="Literal")

    app.pane.markdown("## IntInput")
    app.widgets.int_input(value=42, start=0, end=100, name="Age")

    app.pane.markdown("## FloatInput")
    app.widgets.float_input(value=3.14, start=0.0, end=10.0, name="Pi")

    app.pane.markdown("## NumberInput (新版)")
    app.widgets.number_input(value=50, start=0, end=100, name="Score")

    app.pane.markdown("## Number (旧版 Indicator)")
    app.widgets.number(value=75, format="{value}%", name="Progress")

    app.pane.markdown("## ArrayInput")
    app.widgets.array_input(value=np.array([1, 2, 3]), name="Array")

    app.pane.markdown("## AutocompleteInput")
    app.widgets.autocomplete_input(value="Python", options=["Python", "Rust", "Go", "TypeScript"], name="Language")

    # Reactive demo: echo input
    text = app.widgets.text_input(value="type here", name="Echo Input")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> You typed: **{text.value}**")

app.servable()

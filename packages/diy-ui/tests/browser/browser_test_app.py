"""Panel 浏览器测试应用 — 覆盖核心信号/组件/Cell 联动场景。

run: uv run panel serve tests/browser_test_app.py --port 0
"""

import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(
    config=diy.ui.ScopeConfig(
        mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
    )
)

with app.layout.column():
    app.pane.markdown("# 🧪 Browser Test App")

    name_input = app.widgets.text_input(name="Name", value="World")

    multiplier_input = app.widgets.radio_button_group(
        name="Multiplier",
        options={"x1": 1, "x2": 2, "x5": 5},
        value=1,
    )

    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(
            f"## Hello **{name_input.value}** × {multiplier_input.value} !"
        )
        app.pane.markdown(f"Repeated: {'🔥' * multiplier_input.value}")

    counter = app.signal(0)

    with app.layout.row():
        btn_dec = app.widgets.button(name="-1")
        btn_inc = app.widgets.button(name="+1")
        btn_dec.on_click(lambda e: setattr(counter, "value", counter.value - 1))
        btn_inc.on_click(lambda e: setattr(counter, "value", counter.value + 1))

    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"Counter: **{counter.value}**")


app.servable()

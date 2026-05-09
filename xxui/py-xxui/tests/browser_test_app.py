"""Panel 浏览器测试应用 — 覆盖核心信号/组件/Cell 联动场景。

run: uv run panel serve tests/browser_test_app.py --port 0
"""

from xxui.providers.panel import PanelApp, PanelColumn
from xxui.scheduler import ImmediateScheduler
from xxui.scope import ScopeConfig

app = PanelApp(config=ScopeConfig(mode="dev", scheduler=ImmediateScheduler()))

with app.column():
    app.markdown("# 🧪 Browser Test App")

    name_input = app.text_input(name="Name", value="World")

    multiplier_input = app.radio_button_group(
        name="Multiplier",
        options={"x1": 1, "x2": 2, "x5": 5},
        value=1,
    )

    @app.column().cell()
    def _(node: PanelColumn):
        app.markdown(f"## Hello **{name_input.value}** × {multiplier_input.value} !")
        app.markdown(f"Repeated: {'🔥' * multiplier_input.value}")

    counter = app.signal(0)

    with app.row():
        btn_dec = app.button(name="-1")
        btn_inc = app.button(name="+1")
        btn_dec.on_click(lambda e: setattr(counter, "value", counter.value - 1))
        btn_inc.on_click(lambda e: setattr(counter, "value", counter.value + 1))

    @app.column().cell()
    def _(node: PanelColumn):
        app.markdown(f"Counter: **{counter.value}**")


app.servable()

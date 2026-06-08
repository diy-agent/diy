# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "输入联动 + 响应式 cell"
# tags = ["reactive", "cell", "signal"]
# ///

"""diy UI Panel Demo — 输入联动 + 响应式 cell。

运行：uv run panel serve examples/panel_demo.py
"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(
    mode=diy.ui.ScopeMode.DEV,
    scheduler=diy.ui.ImmediateScheduler(),
))

# ── 布局 ──
# @app.layout.column().cell()
# def _(node):
with app.layout.column():
    app.pane.markdown("# 🧪 diy UI Panel Demo")

    # 输入组件：wrapper.value 即 signal 值，Panel 事件自动桥接
    name_input = app.widgets.text_input(name="Name", value="World")
    multiplier_input = app.widgets.radio_button_group(
        name="Multiplier",
        options={"x1": 1, "x2": 2, "x5": 5},
        value=1,
    )

    # 响应式 cell：读 wrapper.value → 自动追踪依赖，变化时 rerun
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"## Hello **{name_input.value}** × {multiplier_input.value} !")
        app.pane.markdown(f"Repeated: {'🔥' * multiplier_input.value}")

    # 计数器：手动绑按钮事件
    counter = app.signal(0)

    with app.layout.row():
        # ── 按钮 → signal → cell rerun ──
        # Panel 原生事件 → 设置 signal.value → 依赖 cell 自动 rerun
        # 继承模式下，on_click 直接可用，无需 .target
        app.widgets.button(name="-1").on_click(lambda e: setattr(counter, 'value', counter.value - 1))
        app.widgets.button(name="+1").on_click(lambda e: setattr(counter, 'value', counter.value + 1))

    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"Counter: **{counter.value}**")


app.servable()

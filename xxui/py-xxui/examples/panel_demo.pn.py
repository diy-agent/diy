"""XX UI Panel Demo — 输入联动 + 响应式 cell。

运行：uv run panel serve examples/panel_demo.py
"""
from xxui.providers.panel import PanelApp
from xxui.scheduler import ImmediateScheduler
from xxui.scope import ScopeConfig

app = PanelApp(config=ScopeConfig(
    mode="dev",
    scheduler=ImmediateScheduler(),
))

# ── 布局 ──
# @app.column().cell()
# def _(node):
with app.column():
    app.markdown("# 🧪 XX UI Panel Demo")

    # 输入组件：wrapper.value 即 signal 值，Panel 事件自动桥接
    name_input = app.text_input(name="Name", value="World")
    multiplier_input = app.radio_button_group(
        name="Multiplier",
        options={"x1": 1, "x2": 2, "x5": 5},
        value=1,
    )

    # 响应式 cell：读 wrapper.value → 自动追踪依赖，变化时 rerun
    @app.column().cell()
    def _(node):
        app.markdown(f"## Hello **{name_input.value}** × {multiplier_input.value} !")
        app.markdown(f"Repeated: {'🔥' * multiplier_input.value}")

    # 计数器：手动绑按钮事件
    counter = app.signal(0)

    with app.row():
        # ── 按钮 → signal → cell rerun ──
        # Panel 原生事件 → 设置 signal.value → 依赖 cell 自动 rerun
        # 这是 XX UI 的标准事件桥接模式
        app.button(name="-1").target.on_click(lambda e: setattr(counter, 'value', counter.value - 1))
        app.button(name="+1").target.on_click(lambda e: setattr(counter, 'value', counter.value + 1))

    @app.column().cell()
    def _(node):
        app.markdown(f"Counter: **{counter.value}**")


app.servable()

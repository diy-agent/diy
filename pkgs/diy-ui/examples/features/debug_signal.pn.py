# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "Signal 最小调试页"
# tags = ["debug", "signal", "cell"]
# ///

"""最小调试页：验证 Signal → Cell rerun。

运行：uv run panel serve examples/features/debug_signal.pn.py
"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(
    mode=diy.ui.ScopeMode.PROD,  # 先 PROD 避开 ScopeViolationError
    scheduler=diy.ui.ImmediateScheduler(),
))

# ─── 测试 1: app.signal() + cell（无 widget，纯 signal）───
counter = app.signal(0)

@app.layout.column().cell()
def _(node):
    node.pane.markdown(f"### 测试1: counter = **{counter.value}**")

b1 = app.widgets.button(name="+1 (测试1)")
b1.on_click(lambda e: setattr(counter, "value", counter.value + 1))

# ─── 测试 2: widget value → cell rerun（核心 bug）───
with app.layout.column():
    name_input = app.widgets.text_input(name="名字", value="World")
    mult_input = app.widgets.radio_button_group(
        name="倍数", options={"x1": 1, "x2": 2}, value=1,
    )

    @app.layout.column().cell()
    def _(node):
        node.pane.markdown(f"### 测试2: Hello **{name_input.value}** × {mult_input.value}")
        node.pane.markdown("🔥" * mult_input.value)

app.servable()

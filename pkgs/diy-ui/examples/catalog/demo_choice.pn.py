# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "Choice 组件演示"
# tags = ["choice", "select", "checkbox"]
# ///

"""Choice 组件演示 — 选择类"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Choice 组件")

    app.pane.markdown("## Checkbox")
    app.widgets.checkbox(value=True, name="Accept terms")

    app.pane.markdown("## CheckBoxGroup")
    app.widgets.check_box_group(options=["A", "B", "C"], value=["A", "C"], name="Pick letters")

    app.pane.markdown("## CheckButtonGroup")
    app.widgets.check_button_group(options={"Opt 1": "v1", "Opt 2": "v2"}, value=["v1"], name="Options")

    app.pane.markdown("## MultiChoice (带标签)")
    app.widgets.multi_choice(options=["Red", "Green", "Blue"], value=["Red", "Blue"], name="Colors")

    app.pane.markdown("## MultiSelect")
    app.widgets.multi_select(options=["x", "y", "z"], value=["x", "z"], name="Select multiple")

    app.pane.markdown("## RadioBoxGroup")
    app.widgets.radio_box_group(options={"Small": "S", "Medium": "M", "Large": "L"}, value="M", name="Size")

    app.pane.markdown("## RadioButtonGroup")
    app.widgets.radio_button_group(options={"A": 1, "B": 2, "C": 3}, value=2, name="Group")

    app.pane.markdown("## Select (下拉)")
    app.widgets.select(options={"Python": "py", "Rust": "rs", "Go": "go"}, value="py", name="Language")

    app.pane.markdown("## Switch")
    app.widgets.switch(value=True, name="Enable notifications")

    app.pane.markdown("## Toggle")
    app.widgets.toggle(value=False, name="Dark mode")

    app.pane.markdown("## ToggleIcon")
    app.widgets.toggle_icon(value=False, icon="heart", name="Favourite")

    # Show selected value reactively
    pick = app.widgets.select(options={"A": "alpha", "B": "beta"}, value="alpha", name="Pick")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> Selected: **{pick.value}**")

app.servable()

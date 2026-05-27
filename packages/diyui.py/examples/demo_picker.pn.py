"""Picker 组件演示 — 日期/时间/颜色选择器"""
import diyui
import diyui.providers.panel as diypn
import datetime

app = diypn.PanelApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.DEV, scheduler=diyui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Picker 组件")

    app.pane.markdown("## DatePicker")
    app.widgets.date_picker(value=datetime.date(2025, 6, 15), name="Pick a date")

    app.pane.markdown("## DateRangePicker")
    app.widgets.date_range_picker(value=(datetime.date(2025, 3, 1), datetime.date(2025, 6, 15)), name="Pick date range")

    app.pane.markdown("## DatetimePicker")
    app.widgets.datetime_picker(value=datetime.datetime(2025, 6, 15, 14, 30), name="Pick datetime")

    app.pane.markdown("## DatetimeRangePicker")
    app.widgets.datetime_range_picker(value=(datetime.datetime(2025, 4, 1), datetime.datetime(2025, 6, 15)), name="Pick datetime range")

    app.pane.markdown("## TimePicker")
    app.widgets.time_picker(value=datetime.time(14, 30), name="Pick time")

    app.pane.markdown("## ColorPicker")
    app.widgets.color_picker(value="#4CAF50", name="Pick color")

    app.pane.markdown("## ColorMap (带色标)")
    app.widgets.color_map(options={"Reds": ["white", "red"], "Blues": ["#ffffff", "#0000ff"]}, name="Color Map")

    # Reactive display
    dp = app.widgets.date_picker(value=datetime.date(2025, 6, 15), name="Demo Picker")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> Selected: **{dp.value}**")

app.servable()

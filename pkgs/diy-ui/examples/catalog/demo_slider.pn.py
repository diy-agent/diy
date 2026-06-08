# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "Slider 组件演示"
# tags = ["slider", "range"]
# ///

"""Slider 组件演示 — 滑动条"""
import datetime

import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Slider 组件")

    app.pane.markdown("## IntSlider")
    app.widgets.int_slider(value=50, start=0, end=100, name="Volume")

    app.pane.markdown("## FloatSlider")
    app.widgets.float_slider(value=0.5, start=0.0, end=1.0, step=0.01, name="Ratio")

    app.pane.markdown("## RangeSlider (float)")
    app.widgets.range_slider(value=(0.2, 0.8), start=0.0, end=1.0, name="Range")

    app.pane.markdown("## IntRangeSlider")
    app.widgets.int_range_slider(value=(10, 80), start=0, end=100, name="Int Range")

    app.pane.markdown("## DateSlider")
    app.widgets.date_slider(value=datetime.date(2025, 6, 1), start=datetime.date(2025, 1, 1), end=datetime.date(2025, 12, 31), name="Date")

    app.pane.markdown("## DateRangeSlider")
    app.widgets.date_range_slider(value=(datetime.date(2025, 3, 1), datetime.date(2025, 9, 1)), start=datetime.date(2025, 1, 1), end=datetime.date(2025, 12, 31), name="Date Range")

    app.pane.markdown("## DatetimeSlider")
    app.widgets.datetime_slider(value=datetime.datetime(2025, 6, 15, 12, 0), start=datetime.datetime(2025, 1, 1), end=datetime.datetime(2025, 12, 31), name="Datetime")

    app.pane.markdown("## DatetimeRangeSlider")
    app.widgets.datetime_range_slider(value=(datetime.datetime(2025, 4, 1), datetime.datetime(2025, 10, 1)), start=datetime.datetime(2025, 1, 1), end=datetime.datetime(2025, 12, 31), name="Datetime Range")

    # Reactive display of slider value
    slider = app.widgets.int_slider(value=25, start=0, end=100, name="Demo Slider")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> Slider value: **{slider.value}**")

app.servable()

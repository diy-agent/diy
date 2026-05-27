"""Indicator 组件演示 — 状态/进度显示"""
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.DEV, scheduler=diyui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Indicator 组件")

    app.pane.markdown("## BooleanStatus")
    app.widgets.boolean_status(value=True, name="Online")
    app.widgets.boolean_status(value=False, name="Offline")

    app.pane.markdown("## Gauge")
    app.widgets.gauge(value=65, name="CPU", bounds=(0, 100))

    app.pane.markdown("## LinearGauge")
    app.widgets.linear_gauge(value=42, name="Memory", bounds=(0, 100))

    app.pane.markdown("## Dial")
    app.widgets.dial(value=78, name="Speed", bounds=(0, 100))

    app.pane.markdown("## Progress")
    app.widgets.progress(value=55, name="Loading...")

    app.pane.markdown("## Trend (sparkline)")
    app.widgets.trend(data={"y": [1, 3, 2, 5, 4, 7, 6]}, width=200, height=80, name="Trend")

    app.pane.markdown("## Tqdm (进度条)")
    app.widgets.tqdm(value=60, max=100, layout="column", name="Training")

    app.pane.markdown("## LoadingSpinner")
    app.widgets.loading_spinner(value=True, height=50, name="Spinner")

    # Interactive gauge demo
    slider = app.widgets.int_slider(value=50, start=0, end=100, name="Value")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.widgets.gauge(value=slider.value, name="Live", bounds=(0, 100))

app.servable()

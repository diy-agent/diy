# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "Pane 组件演示"
# tags = ["markdown", "html", "image", "plotly"]
# ///

"""Pane 组件演示 — 26 个展示类组件"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Pane 组件")

    app.pane.markdown("## Alert")
    app.pane.alert("This is an info alert", alert_type="info")
    app.pane.alert("This is a warning", alert_type="warning")
    app.pane.alert("This is danger!", alert_type="danger")

    app.pane.markdown("## Audio (需有效 URL)")
    app.pane.audio("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", name="Audio Player")

    app.pane.markdown("## AVIF / GIF / ICO / JPG / PNG / WebP — 图片格式变体")
    app.pane.avif("https://panel.holoviz.org/_static/logo.png", name="AVIF (fallback)", height=50)
    app.pane.gif("https://panel.holoviz.org/_static/logo.png", name="GIF (fallback)", height=50)
    app.pane.ico("https://panel.holoviz.org/_static/logo.png", name="ICO (fallback)", height=50)
    app.pane.jpg("https://panel.holoviz.org/_static/logo.png", name="JPG (fallback)", height=50)
    app.pane.png("https://panel.holoviz.org/_static/logo.png", name="PNG (fallback)", height=50)
    app.pane.webp("https://panel.holoviz.org/_static/logo.png", name="WebP (fallback)", height=50)

    app.pane.markdown("## Bokeh")
    try:
        from bokeh.models import ColumnDataSource
        from bokeh.plotting import figure
        p = figure(height=150, title="Bokeh Demo")
        p.circle([1, 2, 3, 4], [2, 4, 6, 8], size=10)
        app.pane.bokeh(p)
    except ImportError:
        app.pane.markdown("> bokeh not installed")

    app.pane.markdown("## DataFrame")
    try:
        import pandas as pd
        df = pd.DataFrame({"Name": ["Alice", "Bob"], "Score": [95, 87]})
        app.pane.dataframe(df)
    except ImportError:
        app.pane.markdown("> pandas not installed")

    app.pane.markdown("## DeckGL")
    app.pane.deckgl({}, name="DeckGL (empty)")

    app.pane.markdown("## ECharts")
    app.pane.echarts({"xAxis": {"data": ["A", "B"]}, "series": [{"data": [10, 20]}]}, name="ECharts")

    app.pane.markdown("## HTML")
    app.pane.html("<b>Bold HTML</b> and <i>italic</i>")

    app.pane.markdown("## HoloViews")
    try:
        import holoviews as hv
        hv.extension("bokeh")
        curve = hv.Curve([(0, 0), (1, 1), (2, 4)])
        app.pane.holoviews(curve)
    except ImportError:
        app.pane.markdown("> holoviews not installed")

    app.pane.markdown("## Image")
    app.pane.image("https://panel.holoviz.org/_static/logo.png", height=80)

    app.pane.markdown("## JSON")
    app.pane.json({"name": "diyui", "version": 1}, name="JSON Demo")

    app.pane.markdown("## LaTeX")
    app.pane.latex(r"$\int_{0}^{1} x^2 dx = \frac{1}{3}$")

    app.pane.markdown("## Markdown")
    app.pane.markdown("**Bold** *italic* `code` [link](https://panel.holoviz.org)")

    app.pane.markdown("## Matplotlib")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(3, 1.5))
        ax.plot([1, 2, 3], [1, 4, 9])
        app.pane.matplotlib(fig)
    except ImportError:
        app.pane.markdown("> matplotlib not installed")

    app.pane.markdown("## PDF (需有效 URL)")
    app.pane.pdf("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", name="PDF Viewer", height=200)

    app.pane.markdown("## Placeholder")
    app.pane.placeholder("Placeholder content")

    app.pane.markdown("## Plotly")
    try:
        import plotly.graph_objects as go
        fig = go.Figure(data=go.Bar(x=["A", "B", "C"], y=[1, 3, 2]))
        app.pane.plotly(fig)
    except ImportError:
        app.pane.markdown("> plotly not installed")

    app.pane.markdown("## Str")
    app.pane.str("Hello as string", name="Str Pane")

    app.pane.markdown("## SVG")
    app.pane.svg('<svg width="50" height="50"><circle cx="25" cy="25" r="20" fill="steelblue"/></svg>')

    app.pane.markdown("## Vega (需 $schema)")
    app.pane.vega({"$schema": "https://vega.github.io/schema/vega-lite/v5.json", "mark": "bar", "data": {"values": [{"x": "A", "y": 1}]}, "encoding": {"x": {"field": "x"}, "y": {"field": "y", "type": "quantitative"}}})

    app.pane.markdown("## Video (需有效 URL)")
    app.pane.video("https://www.w3schools.com/html/mov_bbb.mp4", name="Video Player")

app.servable()

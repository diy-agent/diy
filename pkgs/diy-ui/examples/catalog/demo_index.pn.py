# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "组件总览路由导航"
# tags = ["index", "navigation"]
# ///

"""diy UI 组件总览 — 路由导航页面"""

import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# diy UI 组件总览")
    app.pane.markdown("点击分类名称跳转至对应 demo 页面。")

    entries = [
        ("Layout",    "demo_layout",    "容器：Accordion, Card, Column, Row, Tabs, Modal, GridSpec…"),
        ("Pane",      "demo_pane",      "展示：Markdown, HTML, Image, Plotly, ECharts, Video, PDF…"),
        ("Input",     "demo_input",     "输入：TextInput, NumberInput, IntInput, FloatInput…"),
        ("Choice",    "demo_choice",    "选择：Select, Checkbox, Switch, Toggle, MultiChoice…"),
        ("Slider",    "demo_slider",    "滑动条：IntSlider, RangeSlider, DateSlider, DatetimeSlider…"),
        ("Picker",    "demo_picker",    "选择器：DatePicker, TimePicker, ColorPicker, ColorMap…"),
        ("Button",    "demo_button",    "按钮：Button, ButtonIcon, MenuButton, FileDownload…"),
        ("Indicator", "demo_indicator", "指示器：Gauge, Dial, Progress, Trend, Tqdm, LoadingSpinner…"),
        ("Media",     "demo_media",     "媒体：Audio, Video, VideoStream, Player…"),
        ("Code&Data", "demo_code_data", "代码/数据：CodeEditor, Tabulator, StaticText, ToggleIcon"),
    ]

    for name, route, desc in entries:
        app.pane.markdown(f"[**▶ {name}**]({route}.pn)  —  {desc}")

    app.pane.markdown("---")
    app.pane.markdown("*提示：所有 demo 需通过 `panel serve` 启动后页面间跳转才生效。*")

app.servable()

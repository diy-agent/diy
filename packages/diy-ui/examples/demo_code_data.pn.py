"""Code & Data 组件演示"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Code & Data 组件")

    app.pane.markdown("## CodeEditor")
    app.widgets.code_editor(value="def hello():\n    print('Hello, World!')", language="python", height=150, name="Editor", annotations=[])

    app.pane.markdown("## StaticText (只读文本)")
    app.widgets.static_text(value="This is read-only static text", name="Info")

    app.pane.markdown("## Tabulator (数据表)")
    try:
        import pandas as pd
        df = pd.DataFrame({
            "Name": ["Alice", "Bob", "Charlie"],
            "Age": [25, 32, 28],
            "City": ["Beijing", "Shanghai", "Shenzhen"],
        })
        app.widgets.tabulator(value=df, label="Users", height=200)
    except ImportError:
        app.widgets.static_text(value="pandas not installed — cannot demo Tabulator")

    app.pane.markdown("## ToggleIcon")
    app.widgets.toggle_icon(value=False, icon="heart", name="Favourite")

app.servable()

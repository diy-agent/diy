"""Button 组件演示 — 按钮类"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

click_count = app.signal(0)

with app.layout.column():
    app.pane.markdown("# Button 组件")

    app.pane.markdown("## Button")
    btn = app.widgets.button(name="Click me", button_type="primary")
    btn.on_click(lambda e: setattr(click_count, 'value', click_count.value + 1))

    app.pane.markdown("## ButtonIcon")
    app.widgets.button_icon(icon="heart", name="Like")

    app.pane.markdown("## MenuButton")
    app.widgets.menu_button(name="Menu", items=[("Option A", "a"), ("Option B", "b")])

    app.pane.markdown("## FileDownload")
    app.widgets.file_download(file="Hello, World!", filename="hello.txt", name="Download")

    app.pane.markdown("## FileInput")
    app.widgets.file_input(name="Upload File")

    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> Button clicked **{click_count.value}** times")

app.servable()

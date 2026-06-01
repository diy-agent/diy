import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")

with app.setup:
    import datetime
    import time

    import panel as pn

    import diy.ui.providers.panel as diypn
    pn.extension()




@app.cell
def _():
    _app = diypn.PanelApp()

    @_app.layout.column().cell()
    def _(_):
        button = _app.widgets.button(label="启动任务", color="primary")

        @_app.layout.column().cell()
        def _(_):
            if button.value:
                for i in range(3):
                    _app.pane.markdown(f"🔄 执行进度 {i + 1}/3 — {datetime.datetime.now().strftime('%H:%M:%S')}")
                    time.sleep(1)
                _app.pane.markdown(f"✅ 任务完成！— {datetime.datetime.now().strftime('%H:%M:%S')}")
    _app.components[0]
    return


@app.cell
def _():
    _app = diypn.PanelApp()

    @_app.layout.column().cell()
    def _(_):
        button = _app.widgets.button(label="启动任务", color="primary")

        @_app.layout.column().cell()
        def _(_):
            if button.value:
                for i in range(3):
                    _app.pane.markdown(f"🔄 执行进度 {i + 1}/3 — {datetime.datetime.now().strftime('%H:%M:%S')}")
                    time.sleep(1)
                _app.pane.markdown(f"✅ 任务完成！— {datetime.datetime.now().strftime('%H:%M:%S')}")
    _app.components[0]
    return


if __name__ == "__main__":
    app.run()

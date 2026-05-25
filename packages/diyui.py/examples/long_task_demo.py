"""diy UI Panel Demo — 长时间任务 + 步进式 UI。

展示 cell 内长时间任务如何通过 provider 即时同步实现步进式进度展示。
_staging_mode 下每次 _add_child 自动 sync 到 Panel。

运行：uv run panel serve examples/long_task_demo.py
"""
import time
import datetime
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(config=diyui.ScopeConfig(
    mode="dev",
    scheduler=diyui.ImmediateScheduler(),
))

rerun_times = 0

@app.layout.card(title="长时间任务：步进式 UI 更新").cell()
def _(_: diypn.layout.Column):
    button = app.widgets.button(label="启动任务", color="primary")

    @app.layout.card(hide_header=True).cell()
    def _(_: diypn.layout.Column):
        global rerun_times
        rerun_times += 1
        app.pane.markdown(f"🕐注意：`time.sleep()` 会阻塞 Bokeh 事件循环。 {datetime.datetime.now().strftime('%H:%M:%S')} — rerun #{rerun_times}")

        if button.value:
            for i in range(3):
                app.pane.markdown(f"🔄 执行进度 {i + 1}/3 — {datetime.datetime.now().strftime('%H:%M:%S')}")
                time.sleep(1)
            app.pane.markdown(f"✅ 任务完成！— {datetime.datetime.now().strftime('%H:%M:%S')}")

    app.pane.markdown(f"---")
    app.pane.markdown(f"每次 `app.pane.markdown()` 即时同步到浏览器。")
    app.pane.markdown(f"注意：`time.sleep()` 会阻塞 Bokeh 事件循环。")

app.servable()

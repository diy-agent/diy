"""diy UI Panel Demo — Button 同步流。

展示 Button 的新设计：内部维护 Signal[bool]，点击 → True → cell rerun → 自动恢复 False。
运行：uv run panel serve examples/button_sync_demo.py
"""
import diyui
import diyui.providers.panel as diypn
import panel as pn

pn.extension(notifications=True)
import datetime

app = diypn.PanelApp(config=diyui.ScopeConfig(
    mode="dev",
    scheduler=diyui.ImmediateScheduler(),
))
@app.layout.card(title="demo 1: button sync flow").cell()
def _(_: diypn.layout.Column):
    button = app.widgets.button(label="button 1", color="primary")
    button.on_click(lambda e: pn.state.notifications.info("button 1 click"))

    @app.layout.card(hide_header=True).cell()
    def _(_: diypn.layout.Column):
        if button.value:
            app.pane.markdown(f"✅ You clicked button at **{datetime.datetime.now()}**!")
        else:
            app.pane.markdown("👆 Click a button above to see the sync flow.")

    app.pane.markdown("---")
    app.pane.markdown(f"### How it works: rerun time:{datetime.datetime.now()}")
    app.pane.markdown("""
    1. 按钮内部维护 `Signal[bool]`，初始 `False`
    2. 点击 → `signal.value = True`，触发依赖 cell rerun
    3. button 下方cell 读取button.value导致依赖形成
    4. cell 中 `if btn.value:` 读 `True`，进入分支
    5. cell rerun 完成后，`signal` 自动恢复为 `False`（不触发额外 rerun）
    """)
app.pane.markdown("---")

@app.layout.card(title="demo 2: button sync flow , rerun button self block").cell()
def _(_: diypn.layout.Column):
    button = app.widgets.button(label="button 2", color="primary")
    button.on_click(lambda e: pn.state.notifications.info("button 2 click"))
    if button.value:
        app.pane.markdown(f"✅ You clicked button at **{datetime.datetime.now()}**!")
    else:
        app.pane.markdown("👆 Click a button above to see the sync flow.")


    app.pane.markdown("---")
    app.pane.markdown(f"### How it works: rerun time:{datetime.datetime.now()}")
    app.pane.markdown("""
    1. 按钮内部维护 `Signal[bool]`，初始 `False`
    2. 点击 → `signal.value = True`，触发依赖 cell rerun
    3. button 所在cell 读取了button.value导致依赖形成
    4. cell return: 因为button所在cell rerun导致button重建，永远也无法进入if 分支
    5. cell rerun 完成后，`signal` 自动恢复为 `False`（不触发额外 rerun）
    """)

app.servable()

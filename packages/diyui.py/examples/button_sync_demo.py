"""diy UI Panel Demo — Button 同步流。

展示 Button 的新设计：内部维护 Signal[bool]，点击 → True → cell rerun → 自动恢复 False。
类似 marimo run_button 的用法。

运行：uv run panel serve examples/button_sync_demo.py
"""
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(config=diyui.ScopeConfig(
    mode="dev",
    scheduler=diyui.ImmediateScheduler(),
))

with app.layout.column():
    app.pane.markdown("# 🔘 Button Sync Demo")

    # ── Demo 1: Button 在父 scope，子 cell 监听（✅ 正常工作）──
    app.pane.markdown("## Demo 1: Button outside, child cell listens")
    app.pane.markdown("Button 在外部定义，cell 读取 `btn.value` 形成依赖。")

    first_btn = app.widgets.button(label="Option 1", color="primary")
    second_btn = app.widgets.button(label="Option 2", color="success")

    @app.layout.card(hide_header=True).cell()
    def _(node: diypn.layout.Column):
        if first_btn.value:
            app.pane.markdown("✅ You chose **Option 1**!")
        elif second_btn.value:
            app.pane.markdown("✅ You chose **Option 2**!")
        else:
            app.pane.markdown("👆 Click a button above to see the sync flow.")

    app.pane.markdown("---")

    # ── Demo 2: Button 在 cell 内部（❌ 不会进 if 分支）──
    app.pane.markdown("## Demo 2: Button inside cell (button rebuilds each rerun)")
    app.pane.markdown("Button 在 cell 内定义，每次 rerun 重建，`if btn.value:` 永远 False。")

    @app.layout.card(hide_header=True).cell()
    def _(node: diypn.layout.Column):
        btn = app.widgets.button(label="Click Me", color="success")
        if btn.value:
            app.pane.markdown("✅ You clicked!")
        else:
            app.pane.markdown("👆 This button will never show ✓ because it rebuilds each rerun.")

    app.pane.markdown("---")
    app.pane.markdown("### 原理")
    app.pane.markdown("""
    1. Button 内部维护 `Signal[bool]`，初始 `False`
    2. 点击 → `signal.value = True`，触发依赖 cell rerun
    3. cell 中 `if btn.value:` 读 `True`，进入分支
    4. cell rerun 完成后，`signal` 自动恢复为 `False`（不触发额外 rerun）
    """)

app.servable()

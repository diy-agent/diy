"""diy UI Panel Demo — auto_mount_child 开关。

展示 auto_mount_child=False 时，app.widgets.button() 等 factory 不自动挂载组件。
配合 generator cell 的 yield，由 generator driver 接管挂载。

运行：uv run panel serve examples/auto_mount_child_demo.py
"""
import diy.ui
import diy.ui.providers.panel as diypn

# ── 默认模式：auto_mount_child=True（默认）──
app = diypn.PanelApp(
    config=diy.ui.ScopeConfig(
        mode=diy.ui.ScopeMode.DEV,
        scheduler=diy.ui.ImmediateScheduler(),
    )
)

app.pane.markdown("# 🔧 auto_mount_child 演示")
app.pane.markdown("## 默认模式（auto_mount_child=True）")
app.pane.markdown("factory 创建组件后自动挂载到当前容器。")

with app.layout.card(title="默认：button 自动挂载", hide_header=True):
    btn = app.widgets.button(label="自动挂载", name="auto")

app.pane.markdown(f"button 已挂到 card，parent 存在：{btn.parent is not None}")

app.pane.markdown("---")

# ── 解绑模式：auto_mount_child=False ──
app.pane.markdown("## 解绑模式（auto_mount_child=False）")
app.pane.markdown("factory 只创建组件，不挂载。组件的 parent 为 None，"
                  "不在 _children 中，也不在 Panel 原生容器中。")

col = app.layout.card(title="解绑：button 不自动挂载", hide_header=True)
# 给这个容器设 auto_mount_child=False
col._config = diy.ui.ScopeConfig(
    auto_mount_child=False,
    scheduler=diy.ui.ImmediateScheduler(),
)
with col:
    solo_btn = app.widgets.button(label="孤立的按钮", name="solo")

app.pane.markdown(f"solo_btn 不在 col._children：{solo_btn not in col._children}")
app.pane.markdown(f"solo_btn 不在 Panel 容器：{solo_btn not in list(col.objects)}")

# 可以手动挂载
col._add_child(solo_btn)
app.pane.markdown(f"手动挂载后，solo_btn 在容器中：{solo_btn in col._children}")

app.pane.markdown("---")
app.pane.markdown("### 使用场景")
app.pane.markdown("""
- generator cell 自动设置 auto_mount_child=False，由 yield 接管挂载
- 手动构建树：factory 创建 → 手动 `container._add_child(component)`
""")

app.servable()

# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "生成器 cell 演示"
# tags = ["generator", "cell", "yield"]
# ///

"""diy UI Panel Demo — 生成器 cell。

展示 yield 语法：cell 函数是生成器，yield ScopeNode 组件自动挂载到 cell node。
适合长时间任务、step-by-step UI、线性思维。

运行：uv run panel serve examples/generator_cell_demo.py
"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(
    config=diy.ui.ScopeConfig(
        mode=diy.ui.ScopeMode.DEV,
        scheduler=diy.ui.ImmediateScheduler(),
    )
)

# ── 基础：yield 组件 ──
app.pane.markdown("# 🧬 Generator Cell Demo")
app.pane.markdown("yield 的组件自动挂载到 cell node。")

@app.layout.card(title="基础：yield Markdown").cell()
def _(node: diypn.layout.Column):
    yield app.pane.markdown("🔄 步骤 1/3：开始初始化...")
    yield app.pane.markdown("🔄 步骤 2/3：处理数据...")
    yield app.pane.markdown("✅ 步骤 3/3：完成！")

app.pane.markdown("---")

# ── 响应式：signal 变化触发 rerun ──
app.pane.markdown("## 响应式 Generator Cell")
app.pane.markdown("signal 变化 → cell rerun → generator 重新执行 → children 重建。")

count = app.signal(1)

@app.layout.card(title="响应式：count 控制子节点数量").cell()
def _(node: diypn.layout.Column):
    for i in range(count.value):
        yield app.pane.markdown(f"  📄 item {i + 1}")

with app.layout.row():
    app.widgets.button(name="-1").on_click(
        lambda e: setattr(count, "value", max(0, count.value - 1))
    )
    app.widgets.button(name="+1").on_click(
        lambda e: setattr(count, "value", count.value + 1)
    )

app.pane.markdown("---")

# ── 混合：同步 cell + 子 generator cell ──
app.pane.markdown("## 混合：外层同步 cell + 内层 generator cell")
app.pane.markdown("同步 cell 构建布局，generator cell 负责步进式内容。")

flag = app.signal(False)

@app.layout.card(title="混合演示").cell()
def _(node: diypn.layout.Column):
    app.pane.markdown("外层 cell：构建布局。")

    @app.layout.card(title="内层 Generator Cell", hide_header=True).cell()
    def _(inner: diypn.layout.Column):
        yield app.pane.markdown("  ⏳ 子 cell 第 1 步")
        yield app.pane.markdown("  ⏳ 子 cell 第 2 步")
        yield app.pane.markdown("  ✅ 子 cell 完成")

    if flag.value:
        app.pane.markdown("🎉 Flag is True!")
    else:
        app.pane.markdown("Flag 还是 False，点击下面的按钮试试。")

app.widgets.button(label="Toggle Flag").on_click(
    lambda e: setattr(flag, "value", not flag.value)
)

app.servable()

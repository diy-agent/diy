"""diy UI Panel Demo — 异步 cell（yield awaitable）。

展示同步生成器中 yield awaitable（如数据库查询、网络请求）。
awaitable 完成后，结果通过 gen.send() 传回生成器继续执行。

注意：此 demo 需要 Panel serve 环境（Bokeh IOLoop 中的 async scheduler）。
Pane 组件直接展示 awaitable 的结果。

运行：uv run panel serve examples/async_cell_demo.py
"""
import asyncio

import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(
    config=diyui.ScopeConfig(
        mode=diyui.ScopeMode.DEV,
        scheduler=diyui.ImmediateScheduler(),
    )
)

app.pane.markdown("# ⏳ Async Cell Demo")
app.pane.markdown("yield awaitable → scheduler 异步驱动 → 结果传回生成器。")

# ── 模拟异步数据加载 ──

async def fetch_user_name() -> str:
    """模拟数据库查询：1秒后返回用户名。"""
    await asyncio.sleep(1)
    return "Alice"


async def fetch_user_age() -> int:
    """模拟 API 调用：0.5秒后返回年龄。"""
    await asyncio.sleep(0.5)
    return 30


# ── Generator Cell with awaitable ──
# 注意：当前 Phase 4 仅支持同步生成器（非 async def）中 yield awaitable。
# _drive_generator_async 通过 scheduler.enqueue_async 调度。

@app.layout.card(title="异步数据加载（手动测试）").cell()
def _(node: diypn.layout.Column):
    app.pane.markdown("### 异步加载示例")
    app.pane.markdown(
        "此 demo 展示 API 设计。在 Panel serve 环境中，\n"
        "async scheduler 通过 Bokeh IOLoop 驱动 awaitable。"
    )
    app.pane.markdown("当前 cell 为同步模式，直接展示占位内容。")

app.pane.markdown("---")

# ── 纯同步 generator cell 模拟"加载中"效果 ──
app.pane.markdown("## 模拟：同步 generator cell（非异步）")
app.pane.markdown("虽然没有真正的 await，但可以展示 step-by-step UI 效果。")

@app.layout.card(title="同步步骤演示").cell()
def _(node: diypn.layout.Column):
    yield app.pane.markdown("⏳ 正在连接数据库...")
    yield app.pane.markdown("⏳ 正在查询用户信息...")
    yield app.pane.markdown("✅ 加载完成！")

app.pane.markdown("---")
app.pane.markdown("### 异步 cell 完整示例（需要 event loop）")
app.pane.markdown("""
```python
@app.layout.column().cell()
def _(node):
    yield app.pane.markdown("Loading...")
    # yield awaitable → await 后结果传回
    name = yield fetch_user_name()
    yield app.pane.markdown(f"Hello {name}!")
```
""")

app.servable()

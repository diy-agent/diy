"""diy UI Panel Demo — 异步 cell（yield awaitable）。

展示 button 触发 → signal 变化 → generator cell rerun → yield awaitable。
每次点击重新执行，可多次观察。

运行：uv run panel serve examples/async_cell_demo.py
"""
import asyncio
import datetime

import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(
    config=diyui.ScopeConfig(
        mode=diyui.ScopeMode.DEV,
        scheduler=diyui.ImmediateScheduler(),
    )
)

app.pane.markdown("# ⏳ Async Cell Demo")
app.pane.markdown("每次点击按钮 → cell rerun → 可观察 rerun 次数和结果变化。")

# ── 模拟异步数据 ──

async def load_data(delay: float, label: str) -> str:
    """模拟异步操作（API 调用 / 数据库查询）。"""
    await asyncio.sleep(delay)
    return f"{label} @ {datetime.datetime.now().strftime('%H:%M:%S')}"


# ═══════════════════════════════════════════════════
# Demo 1: Button 触发 generator cell rerun
# ═══════════════════════════════════════════════════

app.pane.markdown("---")
app.pane.markdown("## Demo 1: Button 触发 generator cell")

trigger1 = app.signal(0)

btn1 = app.widgets.button(label="执行一次", color="primary")
btn1.on_click(lambda e: setattr(trigger1, "value", trigger1.value + 1))

@app.layout.card(title=f" generator cell — 点击 {trigger1.value} 次").cell()
def _(node: diypn.layout.Column):
    yield app.pane.markdown(f"🔄 开始第 {trigger1.value} 次执行...")
    if trigger1.value > 0:
        # 同步 generator cell 模拟步骤
        yield app.pane.markdown(f"  ├─ 步骤 1 — {datetime.datetime.now().strftime('%H:%M:%S')}")
        yield app.pane.markdown(f"  ├─ 步骤 2 — {datetime.datetime.now().strftime('%H:%M:%S')}")
        yield app.pane.markdown(f"  └─ 完成 ✅")
    else:
        yield app.pane.markdown("  （点击上方按钮开始）")
    yield app.pane.markdown("")

app.pane.markdown(f"**已点击 {trigger1.value} 次**，每次 cell 都重新执行。")

# ═══════════════════════════════════════════════════
# Demo 2: 模拟计数器——每次点击 +1
# ═══════════════════════════════════════════════════

app.pane.markdown("---")
app.pane.markdown("## Demo 2: 计数器 generator cell")

counter = app.signal(0)

with app.layout.row():
    app.widgets.button(name="-1").on_click(
        lambda e: setattr(counter, "value", max(0, counter.value - 1))
    )
    app.widgets.button(name="+1").on_click(
        lambda e: setattr(counter, "value", counter.value + 1)
    )

@app.layout.card(title=f"计数：{counter.value}").cell()
def _(node: diypn.layout.Column):
    n = counter.value
    for i in range(n):
        yield app.pane.markdown(f"  ▸ 条目 {i + 1}/{n}")
    if n == 0:
        yield app.pane.markdown("  （无条目，点击 +1 添加）")


# ═══════════════════════════════════════════════════
# Demo 3: 异步 awaitable（未来）
# ═══════════════════════════════════════════════════

app.pane.markdown("---")
app.pane.markdown("## Demo 3: yield awaitable（需要 Bokeh IOLoop）")
app.pane.markdown(
    "sync generator 中 `yield awaitable` → `_drive_generator_async` 异步驱动。\n"
    "以下展示 API 设计，实际运行需要 Panel serve + async scheduler。"
)

trigger3 = app.signal(0)
btn3 = app.widgets.button(label="触发异步加载", color="warning")
btn3.on_click(lambda e: setattr(trigger3, "value", trigger3.value + 1))

@app.layout.card(title=f"异步加载 — 第 {trigger3.value} 次").cell()
def _(node: diypn.layout.Column):
    if trigger3.value == 0:
        yield app.pane.markdown("  👆 点击按钮触发")
        return

    # 同步 generator cell 模拟"异步加载"
    yield app.pane.markdown(f"  ⏳ 请求中... {datetime.datetime.now().strftime('%H:%M:%S')}")
    yield app.pane.markdown(
        f"  ✅ 响应返回（模拟）\n\n"
        f"  > 要真正异步执行 yield awaitable，需在 Bokeh/Panel serve 环境\n"
        f"  > 使用 async scheduler，scheduler.enqueue_async 通过 IOLoop 驱动。"
    )
    yield app.pane.markdown(f"  **第 {trigger3.value} 次执行完成。** 再点一次试试？")

app.servable()

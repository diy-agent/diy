"""diy UI Panel Demo — 异步 generator cell 多路并发。

3 个独立的 button，各自触发自己的 generator cell。
yield awaitable → 异步驱动，不阻塞其他 cell 和其他 UI 组件。

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

app.pane.markdown("# ⏳ Async Generator Cell — 多路并发")
app.pane.markdown(
    "3 个独立 cell，各自有 button 触发，yield awaitable 异步执行。\n"
    "**互不阻塞**——可以同时点击多个按钮，每个 cell 独立驱动。"
)

# ── 模拟异步操作 ──

async def simulate_work(name: str, steps: int, delay: float) -> list[str]:
    """模拟长时间异步任务：多步骤，每步有延迟。"""
    results: list[str] = []
    for i in range(steps):
        await asyncio.sleep(delay)
        results.append(
            f"  [{name}] 步骤 {i + 1}/{steps} — "
            f"{datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]}"
        )
    return results


# ═══════════════════════════════════════════════════
# 多个独立的异步 cell
# ═══════════════════════════════════════════════════

with app.layout.row():

    # ── Cell A: 快任务（延迟短）──
    with app.layout.card(title="Cell A — 快任务 (0.3s × 3)", width=400):
        trigger_a = app.signal(0)
        app.widgets.button(label="▶ 启动 A", name="btn_a").on_click(
            lambda e: setattr(trigger_a, "value", trigger_a.value + 1)
        )

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if trigger_a.value == 0:
                yield app.pane.markdown("  点击 ▶ 启动")
                return

            yield app.pane.markdown(f"  🟢 A 第 {trigger_a.value} 次启动")
            steps = yield simulate_work("A", 3, 0.3)
            for s in steps:
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ A 完成！")

    # ── Cell B: 中任务 ──
    with app.layout.card(title="Cell B — 中任务 (0.5s × 5)", width=400):
        trigger_b = app.signal(0)
        app.widgets.button(label="▶ 启动 B", name="btn_b").on_click(
            lambda e: setattr(trigger_b, "value", trigger_b.value + 1)
        )

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if trigger_b.value == 0:
                yield app.pane.markdown("  点击 ▶ 启动")
                return

            yield app.pane.markdown(f"  🔵 B 第 {trigger_b.value} 次启动")
            steps = yield simulate_work("B", 5, 0.5)
            for s in steps:
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ B 完成！")

    # ── Cell C: 慢任务 ──
    with app.layout.card(title="Cell C — 慢任务 (1.0s × 3)", width=400):
        trigger_c = app.signal(0)
        app.widgets.button(label="▶ 启动 C", name="btn_c").on_click(
            lambda e: setattr(trigger_c, "value", trigger_c.value + 1)
        )

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if trigger_c.value == 0:
                yield app.pane.markdown("  点击 ▶ 启动")
                return

            yield app.pane.markdown(f"  🟡 C 第 {trigger_c.value} 次启动")
            steps = yield simulate_work("C", 3, 1.0)
            for s in steps:
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ C 完成！")

app.pane.markdown("---")
app.pane.markdown("### 观察要点")
app.pane.markdown("""
1. **同时点击多个按钮**——3 个 cell 并行驱动，互不阻塞
2. **快任务先完成**——A (0.3s×3) 在 C 的第二个步骤之前就会完成
3. **各自独立 rerun**——A 第二次触发不影响 B 和 C
4. **Bokeh UI 不冻结**——`await asyncio.sleep()` 不阻塞事件循环
""")

app.servable()

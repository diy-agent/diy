"""diy UI Panel Demo — 异步 generator cell 多路并发。

3 个独立的 button，各自触发自己的 generator cell。
每步 yield 一个 awaitable → UI 即时更新 → 下一步，步步可见。

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

app.pane.markdown("# ⏳ Async Generator Cell — 步步可见")
app.pane.markdown(
    "每步 yield 一个 awaitable，await 完成后 UI 更新，再下一步。\n"
    "**互不阻塞**——同时点多个按钮，各自独立推进。"
)


# ── 每步一个 awaitable ──

async def step(label: str, n: int, total: int, delay: float) -> str:
    """单步异步操作：延迟后返回时间戳。"""
    await asyncio.sleep(delay)
    return (
        f"  [{label}] {n}/{total} — "
        f"{datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]}"
    )


# ═══════════════════════════════════════════════════
# 3 路并行
# ═══════════════════════════════════════════════════

with app.layout.row():

    # ── Cell A: 快 (0.5s × 5) ──
    with app.layout.card(title="A — 快 (0.5s × 5)", width=400):
        ta = app.signal(0)
        app.widgets.button(label="▶ A", name="btn_a").on_click(
            lambda e: setattr(ta, "value", ta.value + 1)
        )
        app.pane.markdown(f"触发次数：**{ta.value}**")

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if ta.value == 0:
                yield app.pane.markdown("  👆 点按钮")
                return
            yield app.pane.markdown(f"  🟢 启动 #{ta.value}")
            for i in range(5):
                s = yield step("A", i + 1, 5, 0.5)
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ A 完成")

    # ── Cell B: 中 (0.8s × 5) ──
    with app.layout.card(title="B — 中 (0.8s × 5)", width=400):
        tb = app.signal(0)
        app.widgets.button(label="▶ B", name="btn_b").on_click(
            lambda e: setattr(tb, "value", tb.value + 1)
        )
        app.pane.markdown(f"触发次数：**{tb.value}**")

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if tb.value == 0:
                yield app.pane.markdown("  👆 点按钮")
                return
            yield app.pane.markdown(f"  🔵 启动 #{tb.value}")
            for i in range(5):
                s = yield step("B", i + 1, 5, 0.8)
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ B 完成")

    # ── Cell C: 慢 (1.5s × 3) ──
    with app.layout.card(title="C — 慢 (1.5s × 3)", width=400):
        tc = app.signal(0)
        app.widgets.button(label="▶ C", name="btn_c").on_click(
            lambda e: setattr(tc, "value", tc.value + 1)
        )
        app.pane.markdown(f"触发次数：**{tc.value}**")

        @app.layout.card(hide_header=True).cell()
        def _(node: diypn.layout.Column):
            if tc.value == 0:
                yield app.pane.markdown("  👆 点按钮")
                return
            yield app.pane.markdown(f"  🟡 启动 #{tc.value}")
            for i in range(3):
                s = yield step("C", i + 1, 3, 1.5)
                yield app.pane.markdown(s)
            yield app.pane.markdown(f"  ✅ C 完成")


app.pane.markdown("---")
app.pane.markdown("### 观察要点")
app.pane.markdown("""
1. **步步可见** — 每个 yield → await 完成 → UI 更新 → 下一步，不像一次性弹出来
2. **同时点击 A+B+C** — 三路并行，A 先到 5/5，C 还在 2/3
3. **各自独立** — A 的 rerun 不影响 B/C
4. **Bokeh UI 不冻结** — `await asyncio.sleep()` 不阻塞事件循环
""")

app.servable()

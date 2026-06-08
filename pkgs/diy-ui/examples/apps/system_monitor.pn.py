# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.diy]
# description = "系统资源监控面板"
# tags = ["dashboard", "system"]
# ///

"""
系统资源监控面板 — 左进程列表 + 右使用率卡片，刷新频率可调。

运行：uv run panel serve pkgs/diy-ui/examples/system_monitor.py
"""

import asyncio

import pandas as pd
import psutil

import diy.ui.providers.panel as diypn

app = diypn.PanelApp()

app.pane.markdown("# 🖥️ 系统资源监控面板")

# ── 全局 signals ───────────────────────────────────────

tick = app.signal(0)  # 不断递增，驱动所有监控刷新
refresh_interval = app.signal(2.0)  # 刷新间隔(秒)，默认2秒
process_filter = app.signal("")  # 进程名过滤关键字


# ── 后台 tick 推进 ────────────────────────────────────
# 用 async generator cell 形式：循环中 yield None 占位，
# 确保 cell 走 async generator 路径实现持续运行。


with app.layout.card(title="", hide_header=True, visible=False):
    @app.layout.column().cell()
    async def _(node: diypn.layout.Column):
        """持续递增 tick，驱动所有监控刷新。"""
        while True:
            # yield 一个不可见占位防止 cell 退出（yield None 会终止 generator）
            yield app.pane.markdown("", visible=False)
            await asyncio.sleep(refresh_interval.value)
            tick.value += 1


# ── 头部：刷新频率调节 ─────────────────────────────────

with app.layout.row():
    freq_input = app.widgets.text_input(
        label="刷新间隔(秒)",
        value="2",
        placeholder="如 0.5, 1, 3",
        width=200,
    )

    def _on_freq_change(event: object) -> None:
        try:
            val = float(freq_input.value)
            if val > 0:
                refresh_interval.value = val
        except ValueError:
            pass

    freq_input.param.watch(_on_freq_change, "value")


# ── 左右分栏 ──────────────────────────────────────────

with app.layout.row():
    # ═══════════ 左栏：进程列表 + 查询 ═══════════
    with app.layout.card(title="进程列表 (CPU Top 15)", width=620):
        filter_input = app.widgets.text_input(
            label="查询进程",
            placeholder="输入进程名过滤...",
            width=400,
        )

        def _on_filter_change(event: object) -> None:
            process_filter.value = filter_input.value or ""

        filter_input.param.watch(_on_filter_change, "value")

        # 进程表格 cell — 依赖 tick 和 process_filter
        @app.layout.column().cell()
        def _(node: diypn.layout.Column) -> None:
            _ = tick.value
            keyword = process_filter.value.lower().strip()

            processes: list[dict[str, object]] = []
            for proc in psutil.process_iter(
                ["pid", "name", "username", "cpu_percent", "memory_percent"]
            ):
                try:
                    info = proc.info
                    if keyword and keyword not in (info["name"] or "").lower():
                        continue
                    processes.append(info)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass

            df = pd.DataFrame(processes)
            if not df.empty:
                df = df.sort_values(by="cpu_percent", ascending=False).head(15)
                df.columns = ["PID", "名称", "用户", "CPU (%)", "内存 (%)"]

            yield app.widgets.tabulator(
                value=df,
                width=600,
                height=500,
                pagination="remote",
                page_size=15,
                theme="bootstrap5",
            )

    # ═══════════ 右栏：三个使用率卡片 ═══════════
    with app.layout.column():
        # ── CPU 卡片 ──
        with app.layout.card(title="CPU 使用率", width=400):
            @app.layout.column().cell()
            def _(node: diypn.layout.Column) -> None:
                _ = tick.value
                cpu = psutil.cpu_percent(interval=None)
                color = (
                    "green" if cpu < 50 else "orange" if cpu < 80 else "red"
                )
                yield app.pane.markdown(f"## {cpu}%")
                yield app.pane.markdown(
                    f'<div style="width:100%;background:#eee;height:12px;border-radius:4px;">'
                    f'<div style="width:{cpu}%;background:{color};height:12px;'
                    f'border-radius:4px;transition:width 0.3s;"></div></div>',
                    renderer="markdown",
                )

        # ── 内存卡片 ──
        with app.layout.card(title="内存使用率", width=400):
            @app.layout.column().cell()
            def _(node: diypn.layout.Column) -> None:
                _ = tick.value
                mem = psutil.virtual_memory()
                yield app.pane.markdown(f"## {mem.percent}%")
                yield app.pane.markdown(
                    f"已用: {mem.used / 1024**3:.1f} GB / "
                    f"总计: {mem.total / 1024**3:.1f} GB"
                )

        # ── 磁盘卡片 ──
        with app.layout.card(title="磁盘使用率", width=400):
            @app.layout.column().cell()
            def _(node: diypn.layout.Column) -> None:
                _ = tick.value
                usage = psutil.disk_usage("/")
                yield app.pane.markdown(f"## {usage.percent}%")
                yield app.pane.markdown(
                    f"已用: {usage.used / 1024**3:.1f} GB / "
                    f"总计: {usage.total / 1024**3:.1f} GB"
                )

app.servable()

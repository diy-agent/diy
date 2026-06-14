"""PySide6 + asyncio 集成工具。

基于 Qt 6.8+ 内置 QtAsyncio（QAsyncioEventLoopPolicy）。
使用方式：
  1. 先创建 QApplication
  2. 调用 AsyncHelper.init() 设置 asyncio policy
  3. 用 AsyncHelper.run(coro) 调度异步任务
  4. 用 AsyncHelper.run_forever() 替代 app.exec()
"""

from __future__ import annotations

import asyncio
import traceback
from typing import Coroutine

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import QApplication


def init_async(app: QApplication) -> None:
    """初始化 QtAsyncio — 必须在 QApplication 创建后调用。"""
    from PySide6.QtAsyncio import QAsyncioEventLoopPolicy

    asyncio.set_event_loop_policy(QAsyncioEventLoopPolicy())


def run_async(coro: Coroutine) -> asyncio.Task:
    """调度一个异步任务，在后台运行，不阻塞 UI。

    用法：
        async def sync():
            label.setText("Syncing...")
            await asyncio.sleep(2)
            label.setText("Done!")

        run_async(sync())
    """
    task = asyncio.ensure_future(coro)

    def _on_done(t: asyncio.Task) -> None:
        try:
            t.result()
        except Exception:
            traceback.print_exc()

    task.add_done_callback(_on_done)
    return task


def start_event_loop() -> None:
    """启动 asyncio 事件循环（替代 app.exec()）。Qt 事件也会被处理。"""
    asyncio.get_event_loop().run_forever()

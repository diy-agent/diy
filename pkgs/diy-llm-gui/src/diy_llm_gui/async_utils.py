"""PySide6 + asyncio 集成工具。

基于 Qt 6.8+ 内置 QtAsyncio（QAsyncioEventLoopPolicy）。

线程安全规则（关键）：
  ✅ 协程内 await I/O 后直接操作 widget — 安全（协程在主线程恢复）
  ❌ asyncio.to_thread() 内操作 widget — 危险（在线程池，非主线程）
  ❌ run_in_executor() 内操作 widget — 同上
  ⚠️  asyncio.create_subprocess_exec() — QtAsyncio 6.8 未实现
      替代方案：asyncio.to_thread(subprocess.run, ...)

使用方式：
  1. 先创建 QApplication
  2. 调用 init_async(app) 设置 asyncio policy
  3. 用 run_async(coro) 调度异步任务
  4. 用 start_event_loop() 启动（内部用 run_forever，Qt 事件自动集成）

退出方式：
  - 托盘菜单 Quit（推荐，正常清理 serve 子进程）
  - kill <pid>
  - macOS 上 Ctrl+C 无效（Cocoa event loop 屏蔽 SIGINT，Qt 已知限制）
"""

from __future__ import annotations

import asyncio
import traceback
from typing import Coroutine

from PySide6.QtWidgets import QApplication


def init_async(app: QApplication) -> None:
    """初始化 QtAsyncio — 必须在 QApplication 创建后调用。"""
    from PySide6.QtAsyncio import QAsyncioEventLoopPolicy

    asyncio.set_event_loop_policy(QAsyncioEventLoopPolicy())


def run_async(coro: Coroutine) -> asyncio.Task:
    """调度一个异步任务，在后台运行，不阻塞 UI。

    协程在主线程执行，await 后可直接操作 widget。
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
    """启动 asyncio 事件循环（Qt 事件自动集成）。

    run_forever() 替代 app.exec()，QtAsyncio 自动处理 Qt 事件。
    """
    asyncio.get_event_loop().run_forever()

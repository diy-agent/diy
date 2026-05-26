"""Scheduler — 决定 cell rerun 的执行时机。

Scheduler 是 ScopeNode 的配置 facet，不作为全局单例。
v0.1：ImmediateScheduler（同步执行/rerun 中延迟）。
"""

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

from . import _signal as signal_mod


class ImmediateScheduler:
    """enqueue 时通常同步执行。

    rerun 深度 > 0 时（嵌套保护），callback 进入 _pending 队列，
    等 flush() 时执行。
    """

    def __init__(self) -> None:
        self._pending: list[Callable[[], None]] = []

    def enqueue(self, callback: Callable[[], None]) -> None:
        if signal_mod._rerun_depth > 0:
            self._pending.append(callback)
        else:
            callback()
            self._flush_pending()

    def enqueue_async(self, async_callback: Callable[[], Coroutine[Any, Any, None]]) -> None:
        """入队 async callback。

        优先用运行中的 asyncio loop；否则尝试 Tornado IOLoop 的 asyncio_loop；
        都不行则新建 loop。
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                import tornado.ioloop

                loop = tornado.ioloop.IOLoop.current().asyncio_loop  # type: ignore[union-attr]
            except Exception:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
        loop.create_task(async_callback())

    def flush(self) -> None:
        self._flush_pending()

    def _flush_pending(self) -> None:
        while self._pending:
            cb = self._pending.pop(0)
            cb()

"""Scheduler — 决定 cell rerun 的执行时机。

Scheduler 是 ScopeNode 的配置 facet，不作为全局单例。
v0.1：ImmediateScheduler（同步执行/rerun 中延迟）。
"""

from collections.abc import Callable

from xxui import signal as signal_mod


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
            # 执行 callback 期间可能产生新的 pending，flush 处理
            self._flush_pending()

    def flush(self) -> None:
        self._flush_pending()

    def _flush_pending(self) -> None:
        while self._pending:
            cb = self._pending.pop(0)
            cb()

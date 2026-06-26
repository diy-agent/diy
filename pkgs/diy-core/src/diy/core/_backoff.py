"""指数退避定时器 — retry with exponential backoff。

替代所有手写 ``deadline + while + sleep + backoff = min(...)`` 模式。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
核心原则
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

所有 I/O retry 本质是异步操作，不可在 Qt UI 线程用 time.sleep 阻塞。

提供三个变体，按执行上下文选择：

+------------------+------------------------+----------------------------+
| Backoff (同步)    | CLI / 后台线程         | time.sleep 阻塞当前线程     |
| AsyncBackoff     | asyncio 上下文         | await asyncio.sleep 不阻塞  |
| QtBackoff        | Qt UI 线程             | QTimer singleShot 不阻塞 UI |
+------------------+------------------------+----------------------------+

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
实战用法
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1) Backoff.until — 一行搞定轮询（最常用，CLI/线程）::

    from diy.core._backoff import Backoff

    # 等 socket 就绪
    success, _ = Backoff.until(
        lambda: socket.connect(path),
        timeout=15,
        exceptions=(OSError, ConnectionRefusedError),
    )
    if not success:
        raise TimeoutError("socket 未就绪")

    # 等文件锁释放
    import fcntl
    def try_lock():
        fd = os.open(lock_path, os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True

    ok, _ = Backoff.until(try_lock, timeout=5, exceptions=(BlockingIOError,))


2) Backoff 迭代器 — 需要感知次数或中途有额外操作::

    for tick in Backoff(timeout=10):
        resp = do_request()
        if resp.status == 200:
            break
        if tick > 3:
            log.warning("重试 %d 次仍未成功", tick)
    else:
        raise TimeoutError


3) AsyncBackoff — asyncio 上下文::

    async for tick in AsyncBackoff(timeout=10):
        resp = await do_request()
        if resp.status == 200:
            break
    else:
        raise TimeoutError


4) QtBackoff — Qt UI 线程（不阻塞界面）::

    from diy.core._backoff import QtBackoff

    def on_check(tick: int) -> bool:
        \"\"\"返回 True 停止重试，False 继续。\"\"\"
        resp = send(...)
        if resp is not None:
            label.setText(f"完成: {resp}")
            return True
        label.setText(f"等待中 ({tick})...")
        return False

    QtBackoff(on_check, timeout=30).start()


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
何时不该用 Backoff
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 事件可监听时不用轮询（如窗口激活事件 → changeEvent，文件变化 → QFileSystemWatcher）
- 有同步原语时优先用同步原语（threading.Event、asyncio.Event、QSemaphore）
- QTimer.singleShot(0, fn) 的「延迟到下一帧」不是 retry，不应由 Backoff 替代
"""

from __future__ import annotations

import time as _time
from collections.abc import Callable
from typing import Any

# ═══════════════════════════════════════════════════════════
# 同步 Backoff — CLI / 后台线程
# ═══════════════════════════════════════════════════════════


class Backoff:
    """同步指数退避定时器（time.sleep 阻塞当前线程）。

    ⚠️ 禁止在 Qt UI 线程使用！会阻塞事件循环导致界面冻结。
       UI 线程请用 QtBackoff（事件驱动）。

    Args:
        timeout: 最大等待秒数（monotonic clock）
        initial: 初始等待秒数
        max_delay: 最大等待秒数（退避上限）
        multiplier: 退避倍数

    Usage::

        for tick in Backoff(timeout=5):
            resp = send(...)
            if resp is not None:
                break
        else:
            raise TimeoutError("操作超时")
    """

    def __init__(
        self,
        timeout: float = 10.0,
        initial: float = 0.05,
        max_delay: float = 1.0,
        multiplier: float = 1.5,
    ) -> None:
        if timeout < 0:
            raise ValueError("timeout must be non-negative")
        if initial <= 0:
            raise ValueError("initial must be positive")
        if max_delay < initial:
            raise ValueError("max_delay must be >= initial")
        if multiplier <= 1.0:
            raise ValueError("multiplier must be > 1.0")

        self._deadline = _time.monotonic() + timeout
        self._delay = initial
        self._max_delay = max_delay
        self._multiplier = multiplier
        self._tick = 0

    def __iter__(self) -> Backoff:
        return self

    def __next__(self) -> int:
        """返回当前 tick 序号（从 1 开始）。到达 deadline 时 StopIteration。"""
        now = _time.monotonic()
        if now >= self._deadline:
            raise StopIteration
        self._tick += 1
        remaining = self._deadline - now
        sleep_for = min(self._delay, remaining)
        if sleep_for > 0:
            _time.sleep(sleep_for)
        self._delay = min(self._delay * self._multiplier, self._max_delay)
        return self._tick

    @property
    def tick(self) -> int:
        """当前已尝试次数（0 = 尚未迭代）。"""
        return self._tick

    @property
    def remaining(self) -> float:
        """剩余可用秒数。"""
        return max(0.0, self._deadline - _time.monotonic())

    @staticmethod
    def until(
        condition: Callable[[], Any],
        *,
        timeout: float = 10.0,
        initial: float = 0.05,
        max_delay: float = 1.0,
        multiplier: float = 1.5,
        exceptions: tuple = (),
    ) -> tuple[bool, Any]:
        """方便版：轮询直到 condition() 返回真值或超时。

        返回 ``(成功否, 最后一次结果)``。

        Args:
            condition: 每次迭代调用的无参函数，返回真值表示就绪
            timeout: 最大等待秒数
            initial: 初始等待秒数
            max_delay: 最大等待秒数
            multiplier: 退避倍数
            exceptions: 捕获并继续重试的异常元组

        Usage::

            success, resp = Backoff.until(
                lambda: socket.connect(path),
                timeout=15,
                exceptions=(OSError, ConnectionRefusedError),
            )
            if not success:
                raise TimeoutError
        """
        last: Any = None
        for _ in Backoff(
            timeout=timeout, initial=initial, max_delay=max_delay, multiplier=multiplier
        ):
            try:
                last = condition()
                if last:
                    return True, last
            except exceptions:
                continue
        return False, last

    def __repr__(self) -> str:
        return (
            f"<Backoff tick={self._tick} "
            f"delay={self._delay:.3f}s "
            f"remaining={self.remaining:.1f}s>"
        )


# ═══════════════════════════════════════════════════════════
# 异步 Backoff — asyncio 上下文
# ═══════════════════════════════════════════════════════════


class AsyncBackoff:
    """异步指数退避定时器（await asyncio.sleep 不阻塞事件循环）。

    用法同 Backoff，但用 ``async for`` 替代 ``for``。

    Usage::

        async for tick in AsyncBackoff(timeout=5):
            resp = await send(...)
            if resp:
                break
        else:
            raise TimeoutError("操作超时")
    """

    def __init__(
        self,
        timeout: float = 10.0,
        initial: float = 0.05,
        max_delay: float = 1.0,
        multiplier: float = 1.5,
    ) -> None:
        if timeout < 0:
            raise ValueError("timeout must be non-negative")
        if initial <= 0:
            raise ValueError("initial must be positive")
        if max_delay < initial:
            raise ValueError("max_delay must be >= initial")
        if multiplier <= 1.0:
            raise ValueError("multiplier must be > 1.0")

        self._deadline = _time.monotonic() + timeout
        self._delay = initial
        self._max_delay = max_delay
        self._multiplier = multiplier
        self._tick = 0

    def __aiter__(self) -> AsyncBackoff:
        return self

    async def __anext__(self) -> int:
        import asyncio

        now = _time.monotonic()
        if now >= self._deadline:
            raise StopAsyncIteration
        self._tick += 1
        remaining = self._deadline - now
        sleep_for = min(self._delay, remaining)
        if sleep_for > 0:
            await asyncio.sleep(sleep_for)
        self._delay = min(self._delay * self._multiplier, self._max_delay)
        return self._tick

    @property
    def tick(self) -> int:
        """当前已尝试次数（0 = 尚未迭代）。"""
        return self._tick

    @property
    def remaining(self) -> float:
        """剩余可用秒数。"""
        return max(0.0, self._deadline - _time.monotonic())

    def __repr__(self) -> str:
        return (
            f"<AsyncBackoff tick={self._tick} "
            f"delay={self._delay:.3f}s "
            f"remaining={self.remaining:.1f}s>"
        )


# ═══════════════════════════════════════════════════════════
# Qt Backoff — Qt UI 线程（事件驱动，不阻塞）
# ═══════════════════════════════════════════════════════════


class QtBackoff:
    """Qt UI 线程安全的指数退避定时器（QTimer singleShot 事件驱动）。

    不在 UI 线程 sleep，而是每次重试通过 QTimer.singleShot 调度，
    不阻塞事件循环，UI 保持响应。

    Args:
        callback: ``callback(tick: int) -> bool``，返回 True 停止重试
        timeout: 最大等待秒数
        initial_ms: 初始等待毫秒数
        max_delay_ms: 最大等待毫秒数
        multiplier: 退避倍数

    Usage::

        def on_retry(tick: int) -> bool:
            resp = send(...)
            if resp is not None:
                print("done:", resp)
                return True   # 停止重试
            return False      # 继续重试

        QtBackoff(on_retry, timeout=5).start()
    """

    def __init__(
        self,
        callback: Callable[[int], bool],
        *,
        timeout: float = 10.0,
        initial_ms: int = 50,
        max_delay_ms: int = 1000,
        multiplier: float = 1.5,
    ):
        if timeout < 0:
            raise ValueError("timeout must be non-negative")
        if initial_ms <= 0:
            raise ValueError("initial_ms must be positive")
        if max_delay_ms < initial_ms:
            raise ValueError("max_delay_ms must be >= initial_ms")
        if multiplier <= 1.0:
            raise ValueError("multiplier must be > 1.0")

        self._callback = callback
        self._deadline = _time.monotonic() + timeout
        self._delay_ms = initial_ms
        self._max_delay_ms = max_delay_ms
        self._multiplier = multiplier
        self._tick_count = 0

    def start(self) -> None:
        """启动定时重试链。首次重试立即调度（delay=0）。"""
        self._schedule(0)

    def _schedule(self, delay_ms: int) -> None:
        from PySide6.QtCore import QTimer  # noqa: PLC0415

        if self._is_expired():
            return

        # 注意：self._on_tick 是方法名，不可与 self._tick_count 冲突
        QTimer.singleShot(delay_ms, self._on_tick)

    def _on_tick(self) -> None:
        if self._is_expired():
            return

        self._tick_count += 1

        # 调用回调，返回 True 表示完成
        try:
            if self._callback(self._tick_count):
                return
        except Exception:
            pass  # 回调异常当作"未就绪"，继续重试

        # 调度下一次
        self._schedule(self._delay_ms)

        # 指数退避
        self._delay_ms = min(
            int(self._delay_ms * self._multiplier),
            self._max_delay_ms,
        )

    def _is_expired(self) -> bool:
        return _time.monotonic() >= self._deadline

    @property
    def tick(self) -> int:
        """当前已尝试次数（0 = 尚未启动）。"""
        return self._tick_count

    @property
    def remaining(self) -> float:
        """剩余可用秒数。"""
        return max(0.0, self._deadline - _time.monotonic())

    def __repr__(self) -> str:
        return (
            f"<QtBackoff tick={self._tick_count} "
            f"delay={self._delay_ms}ms "
            f"remaining={self.remaining:.1f}s>"
        )

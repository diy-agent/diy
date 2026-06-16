"""Signal[T] — diy.ui 状态原语。

Signal 是独立 runtime primitive，可直接构造，不依赖 App。
UI 响应式 rerun 需用 app.signal() 创建 scope signal。
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from typing import Any, ClassVar, Protocol


class ScopeViolationError(Exception):
    """跨 scope 访问 signal 异常。"""

    pass


class SignalObserver(Protocol):
    """Signal 变化的观察者接口，替代硬编码的 ScopeNode。"""
    def on_signal_changed(self, signal: Signal[Any]) -> None: ...


class SignalContext(Protocol):
    """Signal 访问的上下文接口，替代静态全局依赖。"""
    def on_signal_read(self, signal: Signal[Any]) -> bool: ...


from contextvars import ContextVar

_signal_context: ContextVar[SignalContext | None] = ContextVar("diyui_signal_context", default=None)


class Signal[T]:
    """可观察的单值状态容器。

    读写规则：
    - 读取 .value：若存在 context，注册依赖。
    - 写入 .value：新旧值相等则跳过；否则通知观察者，触发 context / cell rerun。
    """

    _context_var: ClassVar[ContextVar[SignalContext | None]] = _signal_context

    @classmethod
    def _get_context(cls) -> SignalContext | None:
        return cls._context_var.get()

    @classmethod
    def _set_context(cls, context: SignalContext | None) -> Any:
        return cls._context_var.set(context)

    __slots__ = (
        "_value",
        "_observers",
        "_owner",
        "_tracker",
        "_system_observers",
        "_reset_on_complete",
    )

    def __init__(self, value: T) -> None:
        self._value: T = value
        self._observers: list[Callable[[T], None]] = []
        self._owner: object | None = None
        self._tracker: Callable[[Signal[T]], None] | None = None
        self._system_observers: set[SignalObserver] = set()
        self._reset_on_complete: bool = False

    # ── value ──────────────────────────────────

    @property
    def value(self) -> T:
        context = self._get_context()
        if context is not None and context.on_signal_read(self):
            pass # context handled it
        elif self._tracker is not None:
            self._tracker(self)
        return self._value

    @value.setter
    def value(self, new: T) -> None:
        try:
            if self._value == new:
                return
        except ValueError:
            # DataFrame 等对象的 == 可能返回数组而非 bool，
            # 此时无法比较，直接视为不等
            pass
        self._value = new
        self._notify(new)
        self._trigger_observers()

    # ── owner ──────────────────────────────────

    @property
    def owner(self) -> object | None:
        return self._owner

    @owner.setter
    def owner(self, node: object | None) -> None:
        self._owner = node

    # ── observers ──────────────────────────────

    def on_change(self, callback: Callable[[T], None]) -> Callable[[], None]:
        """注册观察者。返回值是取消订阅函数，重复调用安全。"""
        self._observers.append(callback)

        def unsubscribe() -> None:
            # TODO 为什么吃掉异常？
            with contextlib.suppress(ValueError):
                self._observers.remove(callback)

        return unsubscribe

    # ── system observers ───────────────────────

    def add_system_observer(self, observer: SignalObserver) -> None:
        self._system_observers.add(observer)

    def remove_system_observer(self, observer: SignalObserver) -> None:
        self._system_observers.discard(observer)

    def _trigger_observers(self) -> None:
        """信号变化时，通知所有系统观察者。"""
        for obs in list(self._system_observers):
            obs.on_signal_changed(self)

    # ── emit ──────────────────────────────────

    def emit(self, value: T) -> None:
        """强制发射值，触发所有观察者。绕开 same-value 检查。

        用于 param.Event 类场景（如 Button 点击），value 短暂置 True
        随即被 Panel 重置为 False——若不绕开 same-value skip，第二次点击
        时 signal 已是 True，不会触发 cell rerun。
        """
        self._value = value
        self._notify(value)
        self._trigger_observers()

    # ── auto-reset ────────────────────────────

    def _reset_value(self, value: T) -> None:
        """仅重置内部值，通知 observers 但不触发 cell rerun。

        用于 _reset_on_complete 场景（如 Button 点击后自动恢复 False）。
        调用者需确保已在合适的时机调用（cell 执行完成后的 finally 块）。
        """
        try:
            if self._value == value:
                return
        except ValueError:
            pass
        self._value = value
        self._notify(value)

    # ── internal ───────────────────────────────

    def _notify(self, new_value: T) -> None:
        for cb in self._observers:
            cb(new_value)

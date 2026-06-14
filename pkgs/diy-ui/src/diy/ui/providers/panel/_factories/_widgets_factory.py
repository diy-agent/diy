"""app.widgets.xxx() 工厂基类 — 提供运行时 _add 能力。

_add 在挂载 widget 时统一安装 Signal + event bridge。
这样 wrapper __init__ 中不碰 Signal，避免 init 期间的依赖追踪污染。
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from diy.ui._signal import Signal

if TYPE_CHECKING:
    from .._base import UIComponent
    from .._app import PanelApp


class _WidgetsFactoryBase:
    __slots__ = ("_app",)

    def __init__(self, app: "PanelApp") -> None:
        self._app = app

    def _add(self, comp: "UIComponent") -> "UIComponent":
        """挂载 widget 到当前 context，同时安装 Signal + event bridge。

        设计 A: Signal 不放在 __init__ 中创建，而是由工厂统一安装。
        这样 __init__ 期间 Panel 内部读 self.value 不会污染 cell 依赖。
        """
        if 'value' in comp.param:
            comp._signal = Signal(comp.value)  # type: ignore[attr-defined]
            comp.param.watch(
                lambda event, s=comp: s._signal.__setattr__('value', event.new),  # type: ignore[attr-defined]
                'value',
            )
        self._app._add_to_current(comp)
        return comp

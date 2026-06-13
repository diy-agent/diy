"""app.widgets.xxx() 工厂 — 继承 _WidgetsFactoryGen，添加运行时能力。"""
from __future__ import annotations

from .._base import UIComponent
from ._widgets_factory_gen import _WidgetsFactoryGen


class _WidgetsFactory(_WidgetsFactoryGen):
    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:  # type: ignore[name-defined]
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

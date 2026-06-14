"""app.layout.xxx() 工厂基类 — 提供运行时 _add 能力。"""
from __future__ import annotations

from typing import TYPE_CHECKING

from .._base import UIComponent

if TYPE_CHECKING:
    from .._app import PanelApp


class _LayoutFactoryBase:
    __slots__ = ("_app",)

    def __init__(self, app: "PanelApp") -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp.diy)
        return comp

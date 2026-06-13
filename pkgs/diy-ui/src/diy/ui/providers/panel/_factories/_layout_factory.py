"""app.layout.xxx() 工厂 — 继承 _LayoutFactoryGen，添加运行时能力。"""
from __future__ import annotations

from typing import TYPE_CHECKING

from ._layout_factory_gen import _LayoutFactoryGen

if TYPE_CHECKING:
    from .._app import PanelApp
    from .._base import UIComponent


class _LayoutFactory(_LayoutFactoryGen):
    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

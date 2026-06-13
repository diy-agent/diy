"""app.pane.xxx() 工厂 — 继承 _PaneFactoryGen，添加运行时能力。"""
from __future__ import annotations

from typing import TYPE_CHECKING

from ._pane_factory_gen import _PaneFactoryGen

if TYPE_CHECKING:
    from .._app import PanelApp
    from .._base import UIComponent


class _PaneFactory(_PaneFactoryGen):
    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

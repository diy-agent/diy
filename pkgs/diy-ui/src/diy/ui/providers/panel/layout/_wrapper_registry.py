"""动态生成所有 layout wrapper 类。"""
from __future__ import annotations

from typing import Any

import panel as pn

from .._base import _PANEL_HOST_CTRL, C, UIComponent, _PanelContainerMixin

_MODULE = __name__


# ── 容器公共方法 ──

def _container_enter(self: C) -> C:
    assert self._app is not None
    self._app._push_context(self.diy)
    return self


def _container_exit(self: C, *args: object) -> None:
    assert self._app is not None
    self._app._pop_context()


def _container_post_init(self) -> None:
    self.diy._is_container = True
    self.diy._host_ctrl = _PANEL_HOST_CTRL


# ── 容器 layout（有 _PanelContainerMixin + __enter__/__exit__） ──

_CONTAINERS: list[tuple[str, type]] = [
    ("Accordion",   pn.layout.Accordion),
    ("Card",        pn.layout.Card),
    ("Column",      pn.layout.Column),
    ("Feed",        pn.layout.Feed),
    ("FlexBox",     pn.layout.FlexBox),
    ("FloatPanel",  pn.layout.FloatPanel),
    ("GridBox",     pn.layout.GridBox),
    ("GridSpec",    pn.layout.GridSpec),
    ("GridStack",   pn.layout.GridStack),
    ("Modal",       pn.layout.Modal),
    ("Row",         pn.layout.Row),
    ("Swipe",       pn.layout.Swipe),
    ("Tabs",        pn.layout.Tabs),
    ("WidgetBox",   pn.layout.WidgetBox),
]

_CONTAINER_ATTRS = {
    "__module__": _MODULE,
    "__enter__": _container_enter,
    "__exit__": _container_exit,
    "_diy_post_init": _container_post_init,
}

for _name, _panel_cls in _CONTAINERS:
    _cls = type(_name, (_PanelContainerMixin, UIComponent, _panel_cls), _CONTAINER_ATTRS)
    globals()[_name] = _cls


# ── 简单 layout（无容器逻辑） ──

_SIMPLES: list[tuple[str, type]] = [
    ("Divider",     pn.layout.Divider),
    ("HSpacer",     pn.layout.HSpacer),
    ("Spacer",      pn.layout.Spacer),
    ("VSpacer",     pn.layout.VSpacer),
]

for _name, _panel_cls in _SIMPLES:
    _cls = type(_name, (UIComponent, _panel_cls), {"__module__": _MODULE})
    globals()[_name] = _cls

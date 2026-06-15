"""动态生成所有 pane wrapper 类。"""
from __future__ import annotations

import panel as pn

from .._base import UIComponent

_PANES: list[tuple[str, type]] = [
    ("Alert",        pn.pane.Alert),
    ("Audio",        pn.pane.Audio),
    ("AVIF",         pn.pane.AVIF),
    ("Bokeh",        pn.pane.Bokeh),
    ("DataFrame",    pn.pane.DataFrame),
    ("DeckGL",       pn.pane.DeckGL),
    ("ECharts",      pn.pane.ECharts),
    ("GIF",          pn.pane.GIF),
    ("HoloViews",    pn.pane.HoloViews),
    ("HTML",         pn.pane.HTML),
    ("ICO",          pn.pane.ICO),
    ("Image",        pn.pane.Image),
    ("JPG",          pn.pane.JPG),
    ("JSON",         pn.pane.JSON),
    ("LaTeX",        pn.pane.LaTeX),
    ("Markdown",     pn.pane.Markdown),
    ("Matplotlib",   pn.pane.Matplotlib),
    ("PDF",          pn.pane.PDF),
    ("Placeholder",  pn.pane.Placeholder),
    ("Plotly",       pn.pane.Plotly),
    ("PNG",          pn.pane.PNG),
    ("Str",          pn.pane.Str),
    ("SVG",          pn.pane.SVG),
    ("Vega",         pn.pane.Vega),
    ("Video",        pn.pane.Video),
    ("WebP",         pn.pane.WebP),
]

_MODULE = __name__

for _name, _panel_cls in _PANES:
    _cls = type(_name, (UIComponent, _panel_cls), {"__module__": _MODULE})
    globals()[_name] = _cls

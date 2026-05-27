"""Panel Trend — pn.widgets.Trend 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class Trend(UIComponent, pn.widgets.Trend):

    def __init__(
        self,
        *,
        label: str = "",
        name: str = "",
        align: Any = "start",
        aspect_ratio: Any | None = None,
        css_classes: list[Any] | None = None,
        design: Any = None,
        height: int | None = None,
        min_width: int | None = None,
        min_height: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        margin: Any | None = (5, 10),
        styles: dict[str, Any] | None = None,
        stylesheets: list[Any] | None = None,
        tags: list[Any] | None = None,
        width: int | None = 300,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,
        value: dict = None,
        plot_x: str = "x",
        plot_y: str = "y",
        selection: list = [],
        data: Any | None = None,
        layout: str = "column",
        plot_color: str = "#428bca",
        plot_type: str = "bar",
        pos_color: str = "#5cb85c",
        neg_color: str = "#d9534f",
        value_change: Any = "auto",

    ) -> None:
        UIComponent.__init__(self)
        self.diy.signal: diyui.Signal[dict] = diyui.Signal[dict](value)
        _label = label or name
        self.diy.init_done: bool = False
        pn.widgets.Trend.__init__(
            self,
            label=_label,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes or [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles or {},
            stylesheets=stylesheets or [],
            tags=tags or [],
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            disabled=disabled,
            plot_x=plot_x,
            plot_y=plot_y,
            selection=selection,
            data=data,
            layout=layout,
            plot_color=plot_color,
            plot_type=plot_type,
            pos_color=pos_color,
            neg_color=neg_color,
            value_change=value_change,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> dict:
        return self.diy.signal.value

    @value.setter
    def value(self, v: dict) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

"""Panel Trend — pn.widgets.Trend 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class Trend(UIComponent, pn.widgets.Trend):

    def __init__(
        self,
        *,
        label: str = "",
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
        pn.widgets.Trend.__init__(
            self,
            label=label,
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

    @property
    def value(self) -> dict:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: dict) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)


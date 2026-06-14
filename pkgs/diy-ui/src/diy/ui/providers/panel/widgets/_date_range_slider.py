"""Panel DateRangeSlider — pn.widgets.DateRangeSlider 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class DateRangeSlider(UIComponent, pn.widgets.DateRangeSlider):

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
        value: Any = None,
        start: Any | None = None,
        end: Any | None = None,
        step: int = 1,
        bar_color: str = "#6baed6",
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        direction: str = "ltr",
        format: str | None = None,
    ) -> None:
        UIComponent.__init__(self)
        pn.widgets.DateRangeSlider.__init__(
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
            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            direction=direction,
            format=format,
        )

    @property
    def value(self) -> Any:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: Any) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)


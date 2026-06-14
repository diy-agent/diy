"""Panel Dial — pn.widgets.Dial 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class Dial(UIComponent, pn.widgets.Dial):

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
        value: float = 0.0,
        bounds: tuple[float, float] = (0, 100),
        colors: list[tuple[float, str]] | None = None,
        format: str = "{value}%",
        annulus_width: float = 10,
        start_angle: float = -135,
        end_angle: float = 135,
        background: str | None = None,
        default_color: str = "#eeeeee",
        label_color: str = "black",
        nan_format: str = "-",
        needle_color: str = "black",
        needle_width: float = 4.0,
        tick_size: int = 10,
        title_size: int | None = None,
        unfilled_color: str = "whitesmoke",
        value_size: int | None = None,
    ) -> None:
        UIComponent.__init__(self)
        pn.widgets.Dial.__init__(
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
            bounds=bounds,
            colors=colors,
            format=format,
            annulus_width=annulus_width,
            start_angle=start_angle,
            end_angle=end_angle,
            background=background,
            default_color=default_color,
            label_color=label_color,
            nan_format=nan_format,
            needle_color=needle_color,
            needle_width=needle_width,
            tick_size=tick_size,
            title_size=title_size,
            unfilled_color=unfilled_color,
            value_size=value_size,
        )

    @property
    def value(self) -> float:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: float) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)


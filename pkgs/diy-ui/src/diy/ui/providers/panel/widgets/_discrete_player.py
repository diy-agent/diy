"""Panel DiscretePlayer — pn.widgets.DiscretePlayer 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class DiscretePlayer(UIComponent, pn.widgets.DiscretePlayer):

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
        options: list[Any] | dict[str, Any] | None = None,
        interval: int = 500,
        loop_policy: str = "once",
        direction: int = 0,
        step: int = 1,
        preview_duration: int = 1500,
        show_loop_controls: bool = True,
        show_value: bool = True,
        value_align: str = "start",
        scale_buttons: int = 1,
        visible_buttons: list = ["slower", "first", "previous", "play", "next", "last", "faster"],
        visible_loop_options: list = ["once", "loop", "reflect"],

    ) -> None:
        UIComponent.__init__(self)
        pn.widgets.DiscretePlayer.__init__(
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
            options=options or [],
            interval=interval,
            loop_policy=loop_policy,
            direction=direction,
            step=step,
            preview_duration=preview_duration,
            show_loop_controls=show_loop_controls,
            show_value=show_value,
            value_align=value_align,
            scale_buttons=scale_buttons,
            visible_buttons=visible_buttons,
            visible_loop_options=visible_loop_options,
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


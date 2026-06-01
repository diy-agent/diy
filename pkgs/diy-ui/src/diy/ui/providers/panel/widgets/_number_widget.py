"""Panel Number — pn.widgets.Number 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class Number(UIComponent, pn.widgets.Number):

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
        value: float = 0.0,
        default_color: str = "gray",
        font_size: str = "18pt",
        format: str = "{value}",
        nan_format: str = "-",
        colors: list[str] | None = None,
        title_size: str = "18pt",
    ) -> None:
        UIComponent.__init__(self)
        self.diy.signal: diy.ui.Signal[float] = diy.ui.Signal[float](value)
        _label = label or name
        self.diy.init_done: bool = False
        pn.widgets.Number.__init__(
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
            default_color=default_color,
            font_size=font_size,
            format=format,
            nan_format=nan_format,
            colors=colors,
            title_size=title_size,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> float:
        return self.diy.signal.value

    @value.setter
    def value(self, v: float) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

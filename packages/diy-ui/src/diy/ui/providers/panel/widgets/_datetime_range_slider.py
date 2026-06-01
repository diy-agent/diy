"""Panel DatetimeRangeSlider — pn.widgets.DatetimeRangeSlider 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class DatetimeRangeSlider(UIComponent, pn.widgets.DatetimeRangeSlider):

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
        self.diy.signal: diy.ui.Signal[Any] = diy.ui.Signal[Any](value)
        _label = label or name
        self.diy.init_done: bool = False
        pn.widgets.DatetimeRangeSlider.__init__(
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
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> Any:
        return self.diy.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

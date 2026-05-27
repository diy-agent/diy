from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class RangeSlider(UIComponent, pn.widgets.RangeSlider):

    def __init__(
        self,
        *,
        label: str = "",
        value: tuple[Any, Any] = (0, 1),
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
        width: int | None = None,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,
        bar_color: str = "#e6e6e6",
        direction: Any = "ltr",
        orientation: Any = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        start: Any = 0,
        end: Any = 1,
        step: float = 0.1,
        format: str | None = None,
    ) -> None:
        _label = label or name
        UIComponent.__init__(self)
        self.diy.signal: diyui.Signal[tuple[Any, Any]] = diyui.Signal(value)
        self.diy.init_done: bool = False
        pn.widgets.RangeSlider.__init__(
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
            bar_color=bar_color,
            direction=direction,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            start=start,
            end=end,
            step=step,
            format=format,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> tuple[Any, Any]:
        return self.diy.signal.value

    @value.setter
    def value(self, v: tuple[Any, Any]) -> None:
        self.diy.signal.value = v
        if getattr(self, "_init_done", False):
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

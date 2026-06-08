"""Panel ColorMap — pn.widgets.ColorMap 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class ColorMap(UIComponent, pn.widgets.ColorMap):

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
        value: str = "viridis",
        options: dict[str, str] | None = None,
        ncols: int = 4,
        swatch_height: int = 20,
        swatch_width: int = 100,
        value_name: str | None = None,
    ) -> None:
        UIComponent.__init__(self)
        self.diy.signal: diy.ui.Signal[str] = diy.ui.Signal[str](value)
        _label = label or name
        self.diy.init_done: bool = False
        _opts = options or {}
        # Panel's ColorMap.value holds color lists, not string keys.
        # Pass the key via value_name so Panel maps it to the actual list.
        # When no options are provided, pass a real color list instead of a string name.
        _use_value_name = value if _opts and value in _opts else None
        _use_value = _use_value_name if _use_value_name else (
            value if isinstance(value, list) else None
        )
        pn.widgets.ColorMap.__init__(
            self,
            label=_label,
            value=_use_value,
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
            options=_opts,
            ncols=ncols,
            swatch_height=swatch_height,
            swatch_width=swatch_width,
            value_name=value_name,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> str:
        return self.diy.signal.value

    @value.setter
    def value(self, v: str) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

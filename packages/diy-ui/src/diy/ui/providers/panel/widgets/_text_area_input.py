from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class TextAreaInput(UIComponent, pn.widgets.TextAreaInput):

    def __init__(
        self,
        *,
        label: str = "",
        value: str = "",
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
        description: str | None = None,
        max_length: int = 5000,
        placeholder: str = "",
        auto_grow: bool = False,
        cols: int = 20,
        max_rows: int | None = None,
        rows: int = 2,
        resizable: str = "both",
    ) -> None:
        _label = label or name
        UIComponent.__init__(self)
        self.diy.signal: diy.ui.Signal[str] = diy.ui.Signal[str](value)
        self.diy.init_done: bool = False
        pn.widgets.TextAreaInput.__init__(
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
            description=description,
            max_length=max_length,
            placeholder=placeholder,
            auto_grow=auto_grow,
            cols=cols,
            max_rows=max_rows,
            rows=rows,
            resizable=resizable,
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

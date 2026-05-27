from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class FileDownload(UIComponent, pn.widgets.FileDownload):

    def __init__(
        self,
        *,
        label: str = "Download file",
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
        icon: str | None = None,
        icon_size: str = "1em",
        auto: bool = True,
        color: Any = "default",
        variant: Any = "solid",
        button_type: Any | None = None,
        button_style: Any | None = None,
        callback: Any | None = None,
        embed: bool = False,
        file: str | None = None,
        filename: str | None = None,
        description: str | None = None,
    ) -> None:
        _label = label or name
        _color = color if color != "default" else (button_type or "default")
        _variant = variant if variant != "solid" else (button_style or "solid")
        UIComponent.__init__(self)
        self.diy.signal: diyui.Signal[Any] = diyui.Signal[Any](None)
        self.diy.init_done: bool = False
        pn.widgets.FileDownload.__init__(
            self,
            label=_label,
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
            icon=icon,
            icon_size=icon_size,
            auto=auto,
            color=_color,
            variant=_variant,
            callback=callback,
            embed=embed,
            file=file,
            filename=filename,
            description=description,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> Any:
        return self.diy.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.diy.signal.value = v
        if getattr(self, "_init_done", False):
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

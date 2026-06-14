from __future__ import annotations

from typing import Any

import panel as pn

from .._base import C, UIComponent, _PanelContainerMixin


class Swipe(_PanelContainerMixin, UIComponent, pn.layout.Swipe):

    def __init__(
        self,
        *children: Any,
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
        margin: Any | None = 0,
        styles: dict[str, Any] | None = None,
        stylesheets: list[Any] | None = None,
        tags: list[Any] | None = None,
        width: int | None = None,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        slider_width: int = 5,
        slider_color: str = "black",
        start: int = 0,
        end: int = 100,
        value: int = 50,
    ) -> None:
        UIComponent.__init__(self)
        pn.layout.Swipe.__init__(
            self,
            *children,
            name=name,
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
            objects=list(children),
            slider_width=slider_width,
            slider_color=slider_color,
            start=start,
            end=end,
            value=value,
        )
        self.diy.panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self.diy)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

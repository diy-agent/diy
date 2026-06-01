from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class Vega(UIComponent, pn.pane.Vega):

    def __init__(
        self,
        object: Any | None = None,
        *,
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
        default_layout: Any = pn.Row,
        debounce: int = 20,
        show_actions: bool = False,
        theme: str | None = None,
    ) -> None:
        UIComponent.__init__(self)
        pn.pane.Vega.__init__(
            self,
            object,
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
            default_layout=default_layout,
            debounce=debounce,
            show_actions=show_actions,
            theme=theme,
        )

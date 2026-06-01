"""Panel HSpacer — pn.layout.HSpacer 的 diyui 包装。

注意：sizing_mode 是只读参数，不能在 __init__ 中传入。"""

from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class HSpacer(UIComponent, pn.layout.HSpacer):

    def __init__(
        self,
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
        margin: Any | None = 0,
        styles: dict[str, Any] | None = None,
        stylesheets: list[Any] | None = None,
        tags: list[Any] | None = None,
        width: int | None = None,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        visible: bool = True,
        loading: bool = False,
    ) -> None:
        UIComponent.__init__(self)
        pn.layout.HSpacer.__init__(
            self,
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
            visible=visible,
            loading=loading,
        )

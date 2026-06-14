"""Panel LoadingSpinner wrapper — 响应式薄封装。

设计原则（所有 wrapper 应遵循）:
  - 薄封装：不做参数变换，Panel 有什么参数就透传什么
  - Signal 外挂：不在 __init__ 创建 Signal，由工厂 _add() 统一安装。
  - 删除项：diy.init_done、_setup_event_bridge、wrapper 内 Signal 创建
    → 全由 _widgets_factory._add() 统一处理到 self.diy.signal
"""

from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class LoadingSpinner(UIComponent, pn.widgets.LoadingSpinner):

    def __init__(
        self,
        *,
        label: str = "",
        value: bool = False,
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
        sizing_mode: Any = "fixed",
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,
        throttle: int = 500,
        bgcolor: str = "light",
        color: str = "dark",
        size: int = 125,
    ) -> None:
        UIComponent.__init__(self)
        pn.widgets.LoadingSpinner.__init__(
            self,
            name=name,
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
            throttle=throttle,
            bgcolor=bgcolor,
            color=color,
            size=size,
        )

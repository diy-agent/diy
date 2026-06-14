"""Panel MenuButton wrapper — 响应式薄封装。

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


class MenuButton(UIComponent, pn.widgets.MenuButton):

    def __init__(
        self,
        *,
        label: str = "",
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
        color: Any = "default",
        variant: Any = "solid",
        button_type: Any | None = None,
        button_style: Any | None = None,
        items: list[Any] | None = None,
        split: bool = False,
    ) -> None:
        _color = color if color != "default" else (button_type or "default")
        _variant = variant if variant != "solid" else (button_style or "solid")
        UIComponent.__init__(self)
        pn.widgets.MenuButton.__init__(
            self,
            label=label,
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
            color=_color,
            variant=_variant,
            items=items or [],
            split=split,
        )
        # Signal + bridge 由工厂 _add() 统一安装到 self.diy.signal

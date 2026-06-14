from __future__ import annotations

"""Panel FileDownload wrapper — 响应式薄封装。

设计原则（所有 wrapper 应遵循）:
  - 薄封装：不做参数变换，Panel 有什么参数就透传什么
  - Signal 外挂：不在 __init__ 创建 Signal，由工厂 _add() 统一安装。
    避免 init 期间 Panel 内部读 self.value 污染 cell 依赖追踪。
    此时 self.diy.signal 为 None，value getter 走 param.__get__ fallback，
    不经过 Signal 上下文——依赖追踪天然不触发，无需 no_dep_tracking。
  - value setter：只设 param.__set__，watch 回调自动推 Signal，不手工写 Signal
  - 删除项：diy.init_done、_setup_event_bridge、wrapper 内 Signal 创建
    → 全由 _widgets_factory._add() 统一处理到 self.diy.signal
"""

from typing import Any

import panel as pn

from .._base import UIComponent


class FileDownload(UIComponent, pn.widgets.FileDownload):

    def __init__(
        self,
        *,
        label: str = "Download file",
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
        _color = color if color != "default" else (button_type or "default")
        _variant = variant if variant != "solid" else (button_style or "solid")
        UIComponent.__init__(self)
        pn.widgets.FileDownload.__init__(
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
            auto=auto,
            color=_color,
            variant=_variant,
            callback=callback,
            embed=embed,
            file=file,
            filename=filename,
            description=description,
        )

    @property
    def value(self) -> Any:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: Any) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)


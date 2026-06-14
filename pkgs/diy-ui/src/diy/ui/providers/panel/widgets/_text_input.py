"""PanelTextInput — pn.widgets.TextInput 的 diy.ui 包装。"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class TextInput(UIComponent, pn.widgets.TextInput):
    """Panel TextInput 包装。value 代理到 signal，同时是 pn.widgets.TextInput 实例。"""

    def __init__(
        self,
        *,
        label: str = "",
        value: str = "",
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
    ) -> None:
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建，因为 Panel 的 _setup_params
        # 会触发 setattr(self, 'value', ...) → 我们的 value.setter → 需要 self.diy.signal
        # label 取代 name：label 优先，name 仅在 label 未设置时作为兼容回退
        pn.widgets.TextInput.__init__(
            self,
            label=label,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes if css_classes is not None else [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles if styles is not None else {},
            stylesheets=stylesheets if stylesheets is not None else [],
            tags=tags if tags is not None else [],
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
        )

    @property
    def value(self) -> str:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: str) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)


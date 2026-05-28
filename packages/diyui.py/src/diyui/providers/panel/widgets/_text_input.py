"""PanelTextInput — pn.widgets.TextInput 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class TextInput(UIComponent, pn.widgets.TextInput):
    """Panel TextInput 包装。value 代理到 signal，同时是 pn.widgets.TextInput 实例。"""

    def __init__(
        self,
        *,
        label: str = "",
        name: str = "",
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
        self.diy.signal: diyui.Signal[str] = diyui.Signal[str](value)
        # label 取代 name：label 优先，name 仅在 label 未设置时作为兼容回退
        _label = label or name
        self.diy.init_done: bool = False
        pn.widgets.TextInput.__init__(
            self,
            label=_label,
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
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> str:
        return self.diy.signal.value

    @value.setter
    def value(self, v: str) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            # 通过 param descriptor 的 __set__ 直接设值，绕过 property 避免递归
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        """Panel 用户输入 -> signal。"""

        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

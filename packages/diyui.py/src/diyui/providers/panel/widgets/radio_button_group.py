"""PanelRadioButtonGroup — pn.widgets.RadioButtonGroup 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

import diyui

from .._base import UIComponent


class RadioButtonGroup(UIComponent, pn.widgets.RadioButtonGroup):
    """Panel RadioButtonGroup 包装，同时是 pn.widgets.RadioButtonGroup 实例。"""

    def __init__(
        self,
        *,
        label: str = "",
        name: str = "",
        value: Any = None,
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
        description: Any | None = None,
        description_delay: int = 500,
        color: Any = "default",
        variant: Any = "solid",
        button_type: Any | None = None,
        button_style: Any | None = None,
        options: Any | None = None,
        orientation: Any = "horizontal",
    ) -> None:
        # label 取代 name：label 优先，name 仅在 label 未设置时作为兼容回退
        _label = label or name
        # color/variant 取代 button_type/button_style：新参数优先
        _color = color if color != "default" else (button_type or "default")
        _variant = variant if variant != "solid" else (button_style or "solid")
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建（同 PanelTextInput）
        self.signal: diyui.Signal[Any] = diyui.Signal[Any](value)
        self._init_done: bool = False
        pn.widgets.RadioButtonGroup.__init__(
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
            description_delay=description_delay,
            color=_color,
            variant=_variant,
            options=options if options is not None else [],
            orientation=orientation,
        )
        self._init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> Any:
        return self.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.signal.value = v
        if getattr(self, "_init_done", False):
            # 通过 param descriptor 的 __set__ 直接设值，绕过 property 避免递归
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.param.watch(on_change, "value")

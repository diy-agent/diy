from __future__ import annotations

from typing import Any

import panel as pn

from diy.ui import no_dep_tracking

from .._base import UIComponent


class Checkbox(UIComponent, pn.widgets.Checkbox):

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
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,
    ) -> None:
        _label = label or name
        UIComponent.__init__(self)
        with no_dep_tracking():
            pn.widgets.Checkbox.__init__(
                self,
                label=_label,
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
            )
        # Signal + bridge 由工厂 _add() 统一安装
        # 不在此处创建 self._signal / self._setup_event_bridge

    @property
    def value(self) -> bool:
        sig = self.__dict__.get('_signal')
        return sig.value if sig is not None else self.param['value'].__get__(self)

    @value.setter
    def value(self, v: bool) -> None:
        self.param['value'].__set__(self, v)

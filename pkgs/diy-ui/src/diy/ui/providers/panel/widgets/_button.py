"""PanelButton — pn.widgets.Button 的 diy.ui 包装。

Button 内部维护 Signal[bool]，类似 TextInput。.value 代理到 signal.value。
点击事件桥接到 signal，cell rerun 完成后自动恢复为 False。

用法：
    btn = app.widgets.button(label="Go")
    if btn.value:
        # 点击后执行一次
        ...
"""

from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import UIComponent


class Button(UIComponent, pn.widgets.Button):
    """Panel Button 包装，同时是 pn.widgets.Button 实例。

    .value 代理到内部 Signal[bool]：
    - 点击 → value = True → 依赖 cell rerun
    - cell rerun 完成后 → value 自动恢复为 False

    注意：value 是 property（覆盖 Panel 的 Event param descriptor），
    因此事件桥接通过 clicks param（普通 Integer）实现，而非 value Event。
    """

    def __init__(
        self,
        *,
        label: str = "",
        name: str = "",
        value: bool = False,
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
        icon: str | None = None,
        icon_size: str = "1em",
        color: Any = "default",
        variant: Any = "solid",
        button_type: Any | None = None,
        button_style: Any | None = None,
    ) -> None:
        # label 取代 name：label 优先，name 仅在 label 未设置时作为兼容回退
        _label = label or name
        # color/variant 取代 button_type/button_style：新参数优先
        _color = color if color != "default" else (button_type or "default")
        _variant = variant if variant != "solid" else (button_style or "solid")
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建，且标记 auto-reset（cell rerun 后恢复 False）
        self.diy.signal: diy.ui.Signal[bool] = diy.ui.Signal[bool](value)
        self.diy.signal._reset_on_complete = True
        self.diy.init_done: bool = False
        pn.widgets.Button.__init__(
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
            description=description,
            description_delay=description_delay,
            icon=icon,
            icon_size=icon_size,
            color=_color,
            variant=_variant,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    # ── value 代理 ────────────────────────────────

    @property
    def value(self) -> bool:
        return self.diy.signal.value

    @value.setter
    def value(self, v: bool) -> None:
        # 仅在初始化期间允许 Panel 内部 setattr。
        # 初始化后不走 signal——点击事件由 clicks watcher 驱动。
        # 这样 Panel Event 的 set-reset 循环不会触发额外 signal 变化。
        if not self.diy.init_done:
            self.diy.signal.value = v

    # ── 事件桥接 ──────────────────────────────────

    def _setup_event_bridge(self) -> None:
        """Panel 按钮点击 → signal.value = True。

        监听 clicks param：Panel Button 点击时 clicks 递增（_process_event 中
        self.clicks += 1），设置 signal 为 True。后续 cell rerun 完成后
        _reset_on_complete 会将 signal 恢复为 False。

        注意：不通过 value Event，因为 value property 覆盖了 Panel 的 Event
        param descriptor。假设监听 value 的话，Panel 的 param.trigger('value')
        会触发 Event 的 set-reset 循环（True→False），每次 set 都会走 value.setter，
        导致多次 signal 变化。因此只监听 clicks 一次递增。
        """

        def on_click(*events: object) -> None:
            self.diy.signal.value = True

        self.param.watch(on_click, "clicks")

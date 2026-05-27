"""Panel Tqdm — pn.widgets.Tqdm 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class Tqdm(UIComponent, pn.widgets.Tqdm):

    def __init__(
        self,
        *,
        label: str = "",
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
        width: int | None = 300,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,
        value: int = 0,
        layout: Any | None = None,
        lock: Any | None = None,
        max: int = 100,
        progress: Any | None = None,
        text: str = "",
        text_pane: Any | None = None,
        write_to_console: bool = False,
    ) -> None:
        UIComponent.__init__(self)
        self.diy.signal: diyui.Signal[int] = diyui.Signal[int](value)
        _label = label or name
        self.diy.init_done: bool = False
        # layout, lock, progress, text_pane are consumed by Tqdm.__init__
        # and must NOT be passed to super().__init__
        pn.widgets.Tqdm.__init__(
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
            layout=layout,
            lock=lock,
            max=max,
            text=text,
            write_to_console=write_to_console,
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> int:
        return self.diy.signal.value

    @value.setter
    def value(self, v: int) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

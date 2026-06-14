from __future__ import annotations

from typing import Any

import panel as pn

from .._base import C, UIComponent, _PanelContainerMixin


class Tabs(_PanelContainerMixin, UIComponent, pn.layout.Tabs):

    def __init__(
        self,
        *children: Any,
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
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        active: int = 0,
        scroll: Any = False,
        closable: bool = False,
        dynamic: bool = False,
        tabs_location: Any = "above",
    ) -> None:
        UIComponent.__init__(self)
        # Don't pass *children AND objects — Tabs extends NamedListLike
        # which passes objects via *objects positional arg
        pn.layout.Tabs.__init__(
            self,
            *children,
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
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            active=active,
            scroll=scroll,
            closable=closable,
            dynamic=dynamic,
            tabs_location=tabs_location,
        )
        self.diy.panel_container = True

    def _add_child(self, child: Any) -> None:
        """将子组件作为未命名 Tab 添加。"""
        super(UIComponent, self)._add_child(child)
        if hasattr(child, "diy"):
            self.append(child)

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self.diy)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

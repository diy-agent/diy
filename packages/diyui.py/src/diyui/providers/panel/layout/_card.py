"""PanelCard — pn.Card 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

import diyui

from .._base import C, UIComponent, _PanelContainerMixin


class Card(_PanelContainerMixin, UIComponent, pn.Card):
    """Panel Card 包装，同时是 pn.Card 实例。"""

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
        scroll: Any = False,
        auto_scroll_limit: int = 0,
        scroll_button_threshold: int = 0,
        scroll_position: int = 0,
        view_latest: bool = False,
        active_header_background: str | None = None,
        button_css_classes: list[Any] | None = None,
        collapsible: bool = True,
        collapsed: bool = False,
        header: Any | None = None,
        header_background: str = "",
        header_color: str = "",
        header_css_classes: list[Any] | None = None,
        hide_header: bool = False,
        title_css_classes: list[Any] | None = None,
        title: str = "",
    ) -> None:
        UIComponent.__init__(self)
        pn.Card.__init__(
            self,
            *children,
            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes or ["card"],
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
            scroll=scroll,
            auto_scroll_limit=auto_scroll_limit,
            scroll_button_threshold=scroll_button_threshold,
            scroll_position=scroll_position,
            view_latest=view_latest,
            active_header_background=active_header_background,
            button_css_classes=button_css_classes or ["card-button"],
            collapsible=collapsible,
            collapsed=collapsed,
            header=header,
            header_background=header_background,
            header_color=header_color,
            header_css_classes=header_css_classes or ["card-header"],
            hide_header=hide_header,
            title_css_classes=title_css_classes or ["card-title"],
            title=title,
        )
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

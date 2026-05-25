"""PanelMarkdown — pn.pane.Markdown 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

import diyui

from .._base import UIComponent


class Markdown(UIComponent, pn.pane.Markdown):
    """Panel Markdown 包装，同时是 pn.pane.Markdown 实例。"""

    def __init__(
        self,
        object: Any | None = None,
        *,
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
        default_layout: Any = pn.Row,
        enable_streaming: bool = False,
        dedent: bool = True,
        disable_anchors: bool = False,
        disable_math: bool = False,
        extensions: list[str] | None = None,
        hard_line_break: bool = False,
        plugins: list[Any] | None = None,
        renderer: Any = "markdown-it",
        renderer_options: dict[str, Any] | None = None,
    ) -> None:
        UIComponent.__init__(self)
        pn.pane.Markdown.__init__(
            self,
            object,
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
            default_layout=default_layout,
            enable_streaming=enable_streaming,
            dedent=dedent,
            disable_anchors=disable_anchors,
            disable_math=disable_math,
            extensions=extensions or ["extra", "smarty", "codehilite"],
            hard_line_break=hard_line_break,
            plugins=plugins or [],
            renderer=renderer,
            renderer_options=renderer_options or {},
        )

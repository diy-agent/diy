"""Panel provider — Panel 原生组件的 diyui 薄包装。

组件参数尽量与 Panel 保持一致。
diyui 在 wrapper 上附加 ScopeNode、Signal、rerun、debug、lifetime 能力。

v0.3: 组件拆分到独立文件，按 Panel 目录习惯摆放：
  - layout/   → PanelColumn, PanelRow, PanelCard
  - pane/     → PanelMarkdown
  - widgets/  → PanelButton, PanelTextInput, PanelRadioButtonGroup
"""

from __future__ import annotations

from typing import Any

import panel as pn

import diyui

from ._base import UIComponent
from .layout.card import PanelCard
from .layout.column import PanelColumn
from .layout.row import PanelRow
from .pane.markdown import PanelMarkdown
from .widgets.button import PanelButton
from .widgets.radio_button_group import PanelRadioButtonGroup
from .widgets.text_input import PanelTextInput

__all__ = [
    "PanelApp",
    "UIComponent",
    "PanelColumn",
    "PanelRow",
    "PanelCard",
    "PanelMarkdown",
    "PanelButton",
    "PanelTextInput",
    "PanelRadioButtonGroup",
]


class PanelApp(diyui.BaseApp):
    """Panel 专属 diyui App。

    用法：app = PanelApp()
    组件方法名和参数与 Panel 原生保持一致。
    """

    def __init__(self, *, config: diyui.ScopeConfig | None = None) -> None:
        if config is None:
            config = diyui.ScopeConfig(scheduler=diyui.ImmediateScheduler())
        super().__init__()
        self._config = config
        self.provider = "panel"

    # ── 容器 ──────────────────────────────────

    def column(
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
    ) -> PanelColumn:
        col = PanelColumn(
            *children,
            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
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
        )
        self._add_to_current(col)
        return col

    def row(
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
    ) -> PanelRow:
        row = PanelRow(
            *children,
            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            scroll=scroll,
        )
        self._add_to_current(row)
        return row

    def card(
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
    ) -> PanelCard:
        card = PanelCard(
            *children,
            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
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
            button_css_classes=button_css_classes,
            collapsible=collapsible,
            collapsed=collapsed,
            header=header,
            header_background=header_background,
            header_color=header_color,
            header_css_classes=header_css_classes,
            hide_header=hide_header,
            title_css_classes=title_css_classes,
            title=title,
        )
        self._add_to_current(card)
        return card

    # ── 展示 ──────────────────────────────────

    def markdown(
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
    ) -> PanelMarkdown:
        md = PanelMarkdown(
            object,
            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
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
            extensions=extensions,
            hard_line_break=hard_line_break,
            plugins=plugins,
            renderer=renderer,
            renderer_options=renderer_options,
        )
        self._add_to_current(md)
        return md

    def button(
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
    ) -> PanelButton:
        btn = PanelButton(
            label=label,
            name=name,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
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
            color=color,
            variant=variant,
            button_type=button_type,
            button_style=button_style,
        )
        self._add_to_current(btn)
        return btn

    # ── 输入 ──────────────────────────────────

    def text_input(
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
    ) -> PanelTextInput:
        inp = PanelTextInput(
            label=label,
            name=name,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
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
        self._add_to_current(inp)
        return inp

    def radio_button_group(
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
    ) -> PanelRadioButtonGroup:
        radio = PanelRadioButtonGroup(
            label=label,
            name=name,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes,
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles,
            stylesheets=stylesheets,
            tags=tags,
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            disabled=disabled,
            description=description,
            description_delay=description_delay,
            color=color,
            variant=variant,
            button_type=button_type,
            button_style=button_style,
            options=options,
            orientation=orientation,
        )
        self._add_to_current(radio)
        return radio

    # ── serve ─────────────────────────────────

    def servable(self) -> Any:
        """找到首个顶层容器/组件，调用 .servable()。"""
        root = self._find_first_real_component(self)
        if root is not None:
            self._sync_tree_to_panel(self)
            return root.servable()  # type: ignore[attr-defined]
        return None

    def _find_first_real_component(self, node: diyui.ScopeNode) -> UIComponent | None:
        """DFS 找到第一个 UIComponent。"""
        if isinstance(node, UIComponent):
            return node
        for child in node._children:
            result = self._find_first_real_component(child)
            if result is not None:
                return result
        return None

    def _sync_tree_to_panel(self, node: diyui.ScopeNode) -> None:
        """将 diyui 树同步到 Panel 原生 children。"""
        if isinstance(node, UIComponent) and node._panel_container:
            node._sync_to_target(node._children)
        for child in node._children:
            self._sync_tree_to_panel(child)

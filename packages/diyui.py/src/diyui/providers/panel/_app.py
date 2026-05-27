"""PanelApp — Panel 专属 diyui App。

用法：app = diypn.PanelApp()
组件方法遵循 Panel 原生子包习惯：
  app.layout.column()    # 同 pn.layout.Column()
  app.pane.markdown()    # 同 pn.pane.Markdown()
  app.widgets.button()   # 同 pn.widgets.Button()
"""

from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from ._base import UIComponent
from .layout import Card, Column, Row
from .pane import Markdown
from .widgets import Button, RadioButtonGroup, Tabulator, TextInput


class _LayoutFactory:
    """app.layout.xxx() 工厂，与 pn.layout 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

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
    ) -> Column:
        col = Column(
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
        self._app._add_to_current(col)
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
    ) -> Row:
        row = Row(
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
        self._app._add_to_current(row)
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
    ) -> Card:
        card = Card(
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
        self._app._add_to_current(card)
        return card


class _PaneFactory:
    """app.pane.xxx() 工厂，与 pn.pane 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

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
    ) -> Markdown:
        md = Markdown(
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
        self._app._add_to_current(md)
        return md


class _WidgetsFactory:
    """app.widgets.xxx() 工厂，与 pn.widgets 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

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
    ) -> Button:
        btn = Button(
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
        self._app._add_to_current(btn)
        return btn

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
    ) -> TextInput:
        inp = TextInput(
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
        self._app._add_to_current(inp)
        return inp

    def tabulator(
        self,
        *,
        label: str = "",
        value: pd.DataFrame | None = None,
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
        selection: list[Any] | None = None,
        aggregators: dict[str, Any] | None = None,
        editables: dict[str, Any] | None = None,
        editors: dict[str, Any] | None = None,
        formatters: dict[str, Any] | None = None,
        hierarchical: bool = False,
        row_height: int = 30,
        show_index: bool = True,
        sorters: list[Any] | None = None,
        text_align: dict[str, str] | str = {},
        titles: dict[str, str] | None = None,
        widths: dict[str, int] | int = {},
        buttons: dict[str, str] | None = None,
        container_popup: bool = True,
        expanded: list[Any] | None = None,
        embed_content: bool = False,
        filters: list[Any] | None = None,
        frozen_columns: list[str] | dict[str, Any] | None = None,
        frozen_rows: list[int] | None = None,
        groups: dict[str, Any] | None = None,
        groupby: list[str] | None = None,
        header_align: dict[str, str] | str = {},
        header_filters: bool | dict[str, Any] | None = None,
        header_tooltips: dict[str, str] | None = None,
        hidden_columns: list[str] | None = None,
        layout: Any = "fit_data_table",
        initial_page_size: int = 20,
        pagination: Any | None = None,
        page: int = 1,
        page_size: int | None = None,
        row_content: Any | None = None,
        selectable: bool | str | int = True,
        selectable_rows: Any | None = None,
        sortable: bool | dict[str, bool] = True,
        theme: Any = "simple",
        theme_classes: list[Any] | None = None,
        title_formatters: dict[str, Any] | None = None,
    ) -> Tabulator:
        tab = Tabulator(
            label=label,
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
            selection=selection,
            aggregators=aggregators,
            editables=editables,
            editors=editors,
            formatters=formatters,
            hierarchical=hierarchical,
            row_height=row_height,
            show_index=show_index,
            sorters=sorters,
            text_align=text_align,
            titles=titles,
            widths=widths,
            buttons=buttons,
            container_popup=container_popup,
            expanded=expanded,
            embed_content=embed_content,
            filters=filters,
            frozen_columns=frozen_columns,
            frozen_rows=frozen_rows,
            groups=groups,
            groupby=groupby,
            header_align=header_align,
            header_filters=header_filters,
            header_tooltips=header_tooltips,
            hidden_columns=hidden_columns,
            layout=layout,
            initial_page_size=initial_page_size,
            pagination=pagination,
            page=page,
            page_size=page_size,
            row_content=row_content,
            selectable=selectable,
            selectable_rows=selectable_rows,
            sortable=sortable,
            theme=theme,
            theme_classes=theme_classes,
            title_formatters=title_formatters,
        )
        self._app._add_to_current(tab)
        return tab

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
    ) -> RadioButtonGroup:
        radio = RadioButtonGroup(
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
        self._app._add_to_current(radio)
        return radio


class PanelApp(diyui.BaseApp):
    """Panel 专属 diyui App。

    用法：app = diypn.PanelApp()
    组件方法遵循 Panel 原生子包习惯：
      app.layout.column()    # 同 pn.layout.Column()
      app.pane.markdown()    # 同 pn.pane.Markdown()
      app.widgets.button()   # 同 pn.widgets.Button()
    """

    def __init__(self, *, config: diyui.ScopeConfig | None = None) -> None:
        if config is None:
            config = diyui.ScopeConfig(scheduler=diyui.ImmediateScheduler())
        super().__init__()
        self._config = config
        self.provider = "panel"
        self.layout = _LayoutFactory(self)
        self.pane = _PaneFactory(self)
        self.widgets = _WidgetsFactory(self)

    # ── serve ─────────────────────────────────

    def servable(self) -> None:
        """将 app 根下所有顶层 UIComponent 注册为 servable。"""
        self._sync_tree_to_panel(self)
        for child in self._children:
            component = self._find_first_real_component(child)
            if component is not None:
                component.servable()  # type: ignore[attr-defined]

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
            node._on_children_replaced(node._children)
        for child in node._children:
            self._sync_tree_to_panel(child)

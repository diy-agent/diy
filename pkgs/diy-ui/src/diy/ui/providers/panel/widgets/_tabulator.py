"""PanelTabulator — pn.widgets.Tabulator 的 diy.ui 包装。

Tabulator 内部维护 Signal[pd.DataFrame]，.value 代理到 signal.value。
支持高性能的数据展示、排序、过滤和分页。

用法：
    table = app.widgets.tabulator(value=df, pagination='remote', page_size=10)
    # 通过 signal 反应式更新数据
    table.value = new_df
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import diy.ui
import panel as pn

from .._base import UIComponent

if TYPE_CHECKING:
    import pandas as pd


class Tabulator(UIComponent, pn.widgets.Tabulator):
    """Panel Tabulator 包装。

    value 属性（DataFrame）代理到内部 Signal，
    使得数据表的变化可以被 Cell 追踪，同时也支持直接修改 .value 触发更新。
    """

    def __init__(
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
    ) -> None:
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建
        self.diy.signal: diy.ui.Signal[pd.DataFrame | None] = diy.ui.Signal(value)
        self.diy.init_done: bool = False
        
        pn.widgets.Tabulator.__init__(
            self,
            label=label,
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
            selection=selection or [],
            aggregators=aggregators or {},
            editables=editables or {},
            editors=editors or {},
            formatters=formatters or {},
            hierarchical=hierarchical,
            row_height=row_height,
            show_index=show_index,
            sorters=sorters or [],
            text_align=text_align,
            titles=titles or {},
            widths=widths,
            buttons=buttons or {},
            container_popup=container_popup,
            expanded=expanded or [],
            embed_content=embed_content,
            filters=filters or [],
            frozen_columns=frozen_columns or [],
            frozen_rows=frozen_rows or [],
            groups=groups or {},
            groupby=groupby or [],
            header_align=header_align,
            header_filters=header_filters,
            header_tooltips=header_tooltips or {},
            hidden_columns=hidden_columns or [],
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
            theme_classes=theme_classes or [],
            title_formatters=title_formatters or {},
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    # ── value 代理 ────────────────────────────────

    @property
    def value(self) -> pd.DataFrame | None:
        return self.diy.signal.value

    @value.setter
    def value(self, v: pd.DataFrame | None) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            # 绕过 property 直接设置 param
            self.param["value"].__set__(self, v)

    # ── 事件桥接 ──────────────────────────────────

    def _setup_event_bridge(self) -> None:
        """Panel 用户操作（如编辑单元格） -> signal。"""

        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "value")

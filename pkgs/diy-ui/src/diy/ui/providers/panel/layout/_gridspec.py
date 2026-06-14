from __future__ import annotations

from typing import Any

import diy.ui
import panel as pn

from .._base import C, UIComponent


class GridSpec(UIComponent, pn.layout.GridSpec):
    """GridSpec 使用 __setitem__ 放置子组件，不支持 append/remove。"""

    def __init__(
        self,
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
        objects: dict[str, Any] | None = None,
        mode: Any = "warn",
        ncols: int | None = None,
        nrows: int | None = None,
    ) -> None:
        UIComponent.__init__(self)
        pn.layout.GridSpec.__init__(
            self,
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
            objects=objects or {},
            mode=mode,
            ncols=ncols,
            nrows=nrows,
        )
        self.diy.panel_container = True

    def _add_child(self, child: diy.ui.ScopeNode) -> None:
        """GridSpec 不支持 append，子组件通过 __setitem__ 定位。"""
        super(UIComponent, self)._add_child(child)

    def _on_child_removed(self, child: diy.ui.ScopeNode) -> None:
        pass

    def _on_children_replaced(self, children: list[diy.ui.ScopeNode]) -> None:
        pass

    def __setitem__(self, key: Any, value: Any) -> None:
        pn.layout.GridSpec.__setitem__(self, key, value)

    def __getitem__(self, key: Any) -> Any:
        return pn.layout.GridSpec.__getitem__(self, key)

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self.diy)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()

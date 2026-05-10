"""Panel provider — Panel 原生组件的 xxui 薄包装。

组件参数尽量与 Panel 保持一致。
xxui 在 wrapper 上附加 ScopeNode、Signal、rerun、debug、lifetime 能力。

v0.2: 组件直接继承 Panel 原生类，无需 .target 即可访问 Panel API。
"""

from __future__ import annotations

from typing import Any, TypeVar

import panel as pn

from xxui.base_app import BaseApp
from xxui.scheduler import ImmediateScheduler
from xxui.scope import ScopeConfig, ScopeNode
from xxui.signal import Signal

T = TypeVar("T")
C = TypeVar("C", bound="UIComponent")


class UIComponent(ScopeNode):
    """provider 原生组件的薄包装。

    xxui 组件直接继承 Panel 原生类，self 就是 provider 原生对象。
    target 属性向后兼容，返回 self。
    provider adapter 方法由子类按需覆写。
    """

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        super().__init__(config=config)
        self._panel_container: bool = False

    @property
    def target(self) -> Any:
        """向后兼容：self 就是 provider 原生对象。"""
        return self

    def _sync_to_target(self, children: list[ScopeNode]) -> None:
        """覆写以同步 ScopeNode children 到 provider target。

        容器组件覆写此方法，例如 Panel Column: self[:] = [c for c in children]
        """
        pass

    def _on_children_replaced(self, children: list[ScopeNode]) -> None:
        """children 被 cell staging 替换后调用。覆写以同步到 provider target。"""
        self._sync_to_target(children)


class _PanelContainerMixin:
    """Panel 容器组件共用的 children 同步逻辑。

    在新继承模型下，self 就是 Panel 容器（pn.Column/Row/Card），
    self.append(child) / self[:] = [...] 直接操作 Panel 原生 children。
    """

    def _add_child(self, child: ScopeNode) -> None:
        super(UIComponent, self)._add_child(child)  # type: ignore[arg-type]
        if not self._staging_mode and isinstance(child, UIComponent):  # type: ignore[attr-defined]
            self.append(child)  # type: ignore[attr-defined]

    def _sync_to_target(self, children: list[ScopeNode]) -> None:
        self[:] = [c for c in children if isinstance(c, UIComponent)]  # type: ignore[index]


# ═══════════════════════════════════════════════
# 容器组件（继承 Panel 原生容器）
# ═══════════════════════════════════════════════


class PanelColumn(_PanelContainerMixin, UIComponent, pn.Column):
    """Panel Column 包装，同时是 pn.Column 实例。"""

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
    ) -> None:
        UIComponent.__init__(self)
        pn.Column.__init__(
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
            scroll=scroll,
            auto_scroll_limit=auto_scroll_limit,
            scroll_button_threshold=scroll_button_threshold,
            scroll_position=scroll_position,
            view_latest=view_latest,
        )
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class PanelRow(_PanelContainerMixin, UIComponent, pn.Row):
    """Panel Row 包装，同时是 pn.Row 实例。"""

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
    ) -> None:
        UIComponent.__init__(self)
        pn.Row.__init__(
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
            scroll=scroll,
        )
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class PanelCard(_PanelContainerMixin, UIComponent, pn.Card):
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


# ═══════════════════════════════════════════════
# 展示组件（继承 Panel 原生展示组件）
# ═══════════════════════════════════════════════


class PanelMarkdown(UIComponent, pn.pane.Markdown):
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


class PanelButton(UIComponent, pn.widgets.Button):
    """Panel Button 包装，同时是 pn.widgets.Button 实例。"""

    def __init__(
        self,
        *,
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
        button_type: Any = "default",
        button_style: Any = "solid",
    ) -> None:
        UIComponent.__init__(self)
        pn.widgets.Button.__init__(
            self,
            name=name,
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
            button_type=button_type,
            button_style=button_style,
        )


# ═══════════════════════════════════════════════
# 输入组件（继承 Panel 原生输入组件，value 代理到 signal）
# ═══════════════════════════════════════════════


class PanelTextInput(UIComponent, pn.widgets.TextInput):
    """Panel TextInput 包装。value 代理到 signal，同时是 pn.widgets.TextInput 实例。"""

    def __init__(
        self,
        *,
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
    ) -> None:
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建，因为 Panel 的 _setup_params
        # 会触发 setattr(self, 'value', ...) → 我们的 value.setter → 需要 self.signal
        self.signal: Signal[str] = Signal[str](value)
        self._init_done: bool = False
        pn.widgets.TextInput.__init__(
            self,
            name=name,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes if css_classes is not None else [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles if styles is not None else {},
            stylesheets=stylesheets if stylesheets is not None else [],
            tags=tags if tags is not None else [],
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
        self._init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> str:
        return self.signal.value

    @value.setter
    def value(self, v: str) -> None:
        self.signal.value = v
        if getattr(self, "_init_done", False):
            # 通过 param descriptor 的 __set__ 直接设值，绕过 property 避免递归
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        """Panel 用户输入 -> signal。"""

        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.param.watch(on_change, "value")


class PanelRadioButtonGroup(UIComponent, pn.widgets.RadioButtonGroup):
    """Panel RadioButtonGroup 包装，同时是 pn.widgets.RadioButtonGroup 实例。"""

    def __init__(
        self,
        *,
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
        button_type: Any = "default",
        button_style: Any = "solid",
        options: Any | None = None,
        orientation: Any = "horizontal",
    ) -> None:
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建（同 PanelTextInput）
        self.signal: Signal[Any] = Signal[Any](value)
        self._init_done: bool = False
        pn.widgets.RadioButtonGroup.__init__(
            self,
            name=name,
            value=value,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes if css_classes is not None else [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles if styles is not None else {},
            stylesheets=stylesheets if stylesheets is not None else [],
            tags=tags if tags is not None else [],
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            disabled=disabled,
            description=description,
            description_delay=description_delay,
            button_type=button_type,
            button_style=button_style,
            options=options if options is not None else [],
            orientation=orientation,
        )
        self._init_done = True
        self._setup_event_bridge()

    @property
    def value(self) -> Any:
        return self.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.signal.value = v
        if getattr(self, "_init_done", False):
            # 通过 param descriptor 的 __set__ 直接设值，绕过 property 避免递归
            self.param["value"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.param.watch(on_change, "value")


# ═══════════════════════════════════════════════
# PanelApp
# ═══════════════════════════════════════════════


class PanelApp(BaseApp):
    """Panel 专属 xxui App。

    用法：app = PanelApp()
    组件方法名和参数与 Panel 原生保持一致。
    """

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        if config is None:
            config = ScopeConfig(scheduler=ImmediateScheduler())
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
        button_type: Any = "default",
        button_style: Any = "solid",
    ) -> PanelButton:
        btn = PanelButton(
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
            button_type=button_type,
            button_style=button_style,
        )
        self._add_to_current(btn)
        return btn

    # ── 输入 ──────────────────────────────────

    def text_input(
        self,
        *,
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
        button_type: Any = "default",
        button_style: Any = "solid",
        options: Any | None = None,
        orientation: Any = "horizontal",
    ) -> PanelRadioButtonGroup:
        radio = PanelRadioButtonGroup(
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

    def _find_first_real_component(self, node: ScopeNode) -> UIComponent | None:
        """DFS 找到第一个 UIComponent。"""
        if isinstance(node, UIComponent):
            return node
        for child in node._children:
            result = self._find_first_real_component(child)
            if result is not None:
                return result
        return None

    def _sync_tree_to_panel(self, node: ScopeNode) -> None:
        """将 xxui 树同步到 Panel 原生 children。"""
        if isinstance(node, UIComponent) and node._panel_container:
            node._sync_to_target(node._children)
        for child in node._children:
            self._sync_tree_to_panel(child)

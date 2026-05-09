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

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        UIComponent.__init__(self)
        pn.Column.__init__(self, *args, **kwargs)
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

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        UIComponent.__init__(self)
        pn.Row.__init__(self, *args, **kwargs)
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

    def __init__(self, *objects: Any, **kwargs: Any) -> None:
        UIComponent.__init__(self)
        pn.Card.__init__(self, *objects, **kwargs)
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

    def __init__(self, object: Any, **kwargs: Any) -> None:
        UIComponent.__init__(self)
        pn.pane.Markdown.__init__(self, object, **kwargs)


class PanelButton(UIComponent, pn.widgets.Button):
    """Panel Button 包装，同时是 pn.widgets.Button 实例。"""

    def __init__(self, **kwargs: Any) -> None:
        UIComponent.__init__(self)
        pn.widgets.Button.__init__(self, **kwargs)


# ═══════════════════════════════════════════════
# 输入组件（继承 Panel 原生输入组件，value 代理到 signal）
# ═══════════════════════════════════════════════


class PanelTextInput(UIComponent, pn.widgets.TextInput):
    """Panel TextInput 包装。value 代理到 signal，同时是 pn.widgets.TextInput 实例。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", "")
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建，因为 Panel 的 _setup_params
        # 会触发 setattr(self, 'value', ...) → 我们的 value.setter → 需要 self.signal
        self.signal: Signal[str] = Signal[str](value)
        self._init_done: bool = False
        pn.widgets.TextInput.__init__(self, **kwargs, value=value)
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
        """Panel 用户输入 → signal。"""

        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.param.watch(on_change, "value")


class PanelRadioButtonGroup(UIComponent, pn.widgets.RadioButtonGroup):
    """Panel RadioButtonGroup 包装，同时是 pn.widgets.RadioButtonGroup 实例。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", None)
        UIComponent.__init__(self)
        # signal 必须在 Panel __init__ 之前创建（同 PanelTextInput）
        self.signal: Signal[Any] = Signal[Any](value)
        self._init_done: bool = False
        pn.widgets.RadioButtonGroup.__init__(self, **kwargs, value=value)
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

    def column(self, *args: Any, **kwargs: Any) -> PanelColumn:
        col = PanelColumn(*args, **kwargs)
        self._add_to_current(col)
        return col

    def row(self, *args: Any, **kwargs: Any) -> PanelRow:
        row = PanelRow(*args, **kwargs)
        self._add_to_current(row)
        return row

    def card(self, *objects: Any, **kwargs: Any) -> PanelCard:
        card = PanelCard(*objects, **kwargs)
        self._add_to_current(card)
        return card

    # ── 展示 ──────────────────────────────────

    def markdown(self, object: Any, **kwargs: Any) -> PanelMarkdown:
        md = PanelMarkdown(object, **kwargs)
        self._add_to_current(md)
        return md

    def button(self, **kwargs: Any) -> PanelButton:
        btn = PanelButton(**kwargs)
        self._add_to_current(btn)
        return btn

    # ── 输入 ──────────────────────────────────

    def text_input(self, **kwargs: Any) -> PanelTextInput:
        inp = PanelTextInput(**kwargs)
        self._add_to_current(inp)
        return inp

    def radio_button_group(self, **kwargs: Any) -> PanelRadioButtonGroup:
        radio = PanelRadioButtonGroup(**kwargs)
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

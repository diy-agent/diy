"""Panel provider — Panel 原生组件的 xxui 薄包装。

组件参数尽量与 Panel 保持一致。
xxui 在 wrapper 上附加 ScopeNode、Signal、rerun、debug、lifetime 能力。
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

    target: provider 原生对象
    provider adapter 方法由子类按需覆写。
    """

    target: Any

    def __init__(self, target: Any, *, config: ScopeConfig | None = None) -> None:
        super().__init__(config=config)
        self.target = target
        self._panel_container: bool = False

    def _sync_to_target(self, children: list[ScopeNode]) -> None:
        """覆写以同步 ScopeNode children 到 provider target。

        容器组件覆写此方法，例如 Panel Column: target[:] = [c.target for c in children]
        """
        pass

    def _on_children_replaced(self, new_children: list[ScopeNode]) -> None:
        """children 被 cell staging 替换后调用。覆写以同步到 provider target。"""
        self._sync_to_target(new_children)


class _PanelContainerMixin:
    """Panel 容器组件共用的 target 同步逻辑。"""

    def _add_child(self: UIComponent, child: ScopeNode) -> None:
        super(UIComponent, self)._add_child(child)
        if not self._staging_mode and isinstance(child, UIComponent):
            self.target.append(child.target)

    def _sync_to_target(self: UIComponent, children: list[ScopeNode]) -> None:
        self.target[:] = [c.target for c in children if isinstance(c, UIComponent)]


# ═══════════════════════════════════════════════
# 容器组件
# ═══════════════════════════════════════════════


class PanelColumn(_PanelContainerMixin, UIComponent):
    """Panel Column 包装。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(pn.Column(*args, **kwargs))
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class PanelRow(_PanelContainerMixin, UIComponent):
    """Panel Row 包装。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(pn.Row(*args, **kwargs))
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class PanelCard(_PanelContainerMixin, UIComponent):
    """Panel Card 包装。"""

    def __init__(self, *objects: Any, **kwargs: Any) -> None:
        super().__init__(pn.Card(*objects, **kwargs))
        self._panel_container = True

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


# ═══════════════════════════════════════════════
# 展示组件
# ═══════════════════════════════════════════════


class PanelMarkdown(UIComponent):
    """Panel Markdown 包装。"""

    def __init__(self, object: Any, **kwargs: Any) -> None:
        super().__init__(pn.pane.Markdown(object, **kwargs))


class PanelButton(UIComponent):
    """Panel Button 包装。"""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(pn.widgets.Button(**kwargs))


# ═══════════════════════════════════════════════
# 输入组件
# ═══════════════════════════════════════════════


class PanelTextInput(UIComponent):
    """Panel TextInput 包装。value 代理到 signal。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", "")
        target = pn.widgets.TextInput(**kwargs, value=value)
        super().__init__(target)
        self.signal: Signal[str] = Signal[str](value)
        self._setup_event_bridge()

    @property
    def value(self) -> str:
        return self.signal.value

    @value.setter
    def value(self, v: str) -> None:
        self.signal.value = v
        self.target.value = v

    def _setup_event_bridge(self) -> None:
        """Panel 用户输入 → signal。"""

        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.target.param.watch(on_change, "value")


class PanelRadioButtonGroup(UIComponent):
    """Panel RadioButtonGroup 包装。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", None)
        target = pn.widgets.RadioButtonGroup(**kwargs, value=value)
        super().__init__(target)
        self.signal: Signal[Any] = Signal[Any](value)
        self._setup_event_bridge()

    @property
    def value(self) -> Any:
        return self.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.signal.value = v
        self.target.value = v

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.signal.value = event.new

        self.target.param.watch(on_change, "value")


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
        # TODO 后面改为多根支持，panel的servable多次执行可以挂载多个组件
        root = self._find_first_real_component(self)
        if root is not None:
            self._sync_tree_to_panel(self)
            return root.target.servable()
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

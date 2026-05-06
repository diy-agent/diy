"""Marimo provider — marimo 原生组件的 xxui 薄包装。

组件参数与 marimo 保持一致。
"""
from __future__ import annotations
from typing import Any, TypeVar
import marimo as mo
from xxui.base_app import BaseApp
from xxui.signal import Signal
from xxui.scope import ScopeNode, ScopeConfig
from xxui.scheduler import ImmediateScheduler

C = TypeVar("C", bound="UIComponent")


class UIComponent(ScopeNode):
    """provider 原生组件的薄包装。"""

    target: Any

    def __init__(self, target: Any, *, config: ScopeConfig | None = None) -> None:
        super().__init__(config=config)
        self.target = target


class _MarimoContainerMixin:
    """marimo 容器组件共用的 target 同步逻辑。"""

    def _add_child(self: UIComponent, child: ScopeNode) -> None:
        super(UIComponent, self)._add_child(child)
        if not self._staging_mode and isinstance(child, UIComponent):
            self.target._live_children.append(child.target)

    def _sync_to_target(self: UIComponent, children: list[ScopeNode]) -> None:
        self.target._live_children[:] = [
            c.target for c in children
            if isinstance(c, UIComponent)
        ]

    def _on_children_replaced(self: UIComponent, children: list[ScopeNode]) -> None:
        self._sync_to_target(children)


# ═══════════════════════════════════════════════
# 容器组件
# ═══════════════════════════════════════════════

class MarimoVStack(_MarimoContainerMixin, UIComponent):
    """marimo vstack 包装。"""

    def __init__(self, children: list[Any] | None = None) -> None:
        children = children or []
        super().__init__(mo.vstack(children))

    def __enter__(self: C) -> C:
        assert self._app is not None
        self._app._push_context(self)
        return self

    def __exit__(self, *args: object) -> None:
        assert self._app is not None
        self._app._pop_context()


class MarimoHStack(_MarimoContainerMixin, UIComponent):
    """marimo hstack 包装。"""

    def __init__(self, children: list[Any] | None = None) -> None:
        children = children or []
        super().__init__(mo.hstack(children))

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

class MarimoMd(UIComponent):
    """marimo markdown 包装。"""

    def __init__(self, text: str) -> None:
        super().__init__(mo.md(text))


class MarimoButton(UIComponent):
    """marimo button 包装。"""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(mo.ui.button(**kwargs))


# ═══════════════════════════════════════════════
# 输入组件
# ═══════════════════════════════════════════════

class MarimoText(UIComponent):
    """marimo text 包装。value 代理到 signal。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", "")
        target = mo.ui.text(**kwargs)
        super().__init__(target)
        self.signal: Signal[str] = Signal[str](value)

    @property
    def value(self) -> str:
        return self.signal.value

    @value.setter
    def value(self, v: str) -> None:
        self.signal.value = v
        self.target._value = v


class MarimoRadio(UIComponent):
    """marimo radio 包装。"""

    def __init__(self, **kwargs: Any) -> None:
        value = kwargs.pop("value", None)
        target = mo.ui.radio(**kwargs)
        super().__init__(target)
        self.signal: Signal[Any] = Signal[Any](value)

    @property
    def value(self) -> Any:
        return self.signal.value

    @value.setter
    def value(self, v: Any) -> None:
        self.signal.value = v
        self.target._value = v


# ═══════════════════════════════════════════════
# MarimoApp
# ═══════════════════════════════════════════════

class MarimoApp(BaseApp):
    """marimo 专属 xxui App。"""

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        if config is None:
            config = ScopeConfig(scheduler=ImmediateScheduler())
        super().__init__()
        self._config = config
        self.provider = "marimo"

    # ── 容器 ──────────────────────────────────

    def vstack(self, *args: Any, **kwargs: Any) -> MarimoVStack:
        stack = MarimoVStack(*args, **kwargs)
        self._add_to_current(stack)
        return stack

    def hstack(self, *args: Any, **kwargs: Any) -> MarimoHStack:
        stack = MarimoHStack(*args, **kwargs)
        self._add_to_current(stack)
        return stack

    # ── 展示 ──────────────────────────────────

    def md(self, text: str) -> MarimoMd:
        md = MarimoMd(text)
        self._add_to_current(md)
        return md

    def button(self, **kwargs: Any) -> MarimoButton:
        btn = MarimoButton(**kwargs)
        self._add_to_current(btn)
        return btn

    # ── 输入 ──────────────────────────────────

    def text(self, **kwargs: Any) -> MarimoText:
        inp = MarimoText(**kwargs)
        self._add_to_current(inp)
        return inp

    def radio(self, **kwargs: Any) -> MarimoRadio:
        radio = MarimoRadio(**kwargs)
        self._add_to_current(radio)
        return radio

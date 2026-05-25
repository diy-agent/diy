"""Panel provider 基础类 — UIComponent 和容器 Mixin。"""

from __future__ import annotations

from typing import Any, TypeVar

import diyui

T = TypeVar("T")
C = TypeVar("C", bound="UIComponent")


class UIComponent(diyui.ScopeNode):
    """provider 原生组件的薄包装。

    diyui 组件直接继承 Panel 原生类，self 就是 provider 原生对象。
    target 属性向后兼容，返回 self。
    provider adapter 方法由子类按需覆写。
    """

    def __init__(self, *, config: diyui.ScopeConfig | None = None) -> None:
        super().__init__(config=config)
        self._panel_container: bool = False

    @property
    def target(self) -> Any:
        """向后兼容：self 就是 provider 原生对象。"""
        return self

    def _sync_to_target(self, children: list[diyui.ScopeNode]) -> None:
        """覆写以同步 ScopeNode children 到 provider target。

        容器组件覆写此方法，例如 Panel Column: self[:] = [c for c in children]
        """
        pass

    def _on_children_replaced(self, children: list[diyui.ScopeNode]) -> None:
        """children 被 cell staging 替换后调用。覆写以同步到 provider target。"""
        self._sync_to_target(children)


class _PanelContainerMixin:
    """Panel 容器组件共用的 children 同步逻辑。

    在新继承模型下，self 就是 Panel 容器（pn.Column/Row/Card），
    self.append(child) / self[:] = [...] 直接操作 Panel 原生 children。
    """

    def _add_child(self, child: diyui.ScopeNode) -> None:
        super(UIComponent, self)._add_child(child)  # type: ignore[arg-type]
        if not self._staging_mode and isinstance(child, UIComponent):  # type: ignore[attr-defined]
            self.append(child)  # type: ignore[attr-defined]

    def _sync_to_target(self, children: list[diyui.ScopeNode]) -> None:
        self[:] = [c for c in children if isinstance(c, UIComponent)]  # type: ignore[index]

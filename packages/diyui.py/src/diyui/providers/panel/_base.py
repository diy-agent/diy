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


class _PanelContainerMixin:
    """Panel 容器组件共用的 children 同步逻辑。

    在新继承模型下，self 就是 Panel 容器（pn.Column/Row/Card），
    self.append(child) / self[:] = [...] 直接操作 Panel 原生 children。
    """

    def _add_child(self, child: diyui.ScopeNode) -> None:
        """添加子节点。非 staging 模式下同时追加到 Panel 原生容器。

        staging 模式下由 _on_child_added 处理即时同步。
        """
        super(UIComponent, self)._add_child(child)  # type: ignore[arg-type]
        if not self._staging_mode and isinstance(child, UIComponent):  # type: ignore[attr-defined]
            self.append(child)  # type: ignore[attr-defined]

    def _on_child_added(self, child: diyui.ScopeNode) -> None:
        """staging 模式下每次 _add_child 即时同步到 Panel。"""
        if isinstance(child, UIComponent):
            self.append(child)  # type: ignore[attr-defined]

    def _on_child_removed(self, child: diyui.ScopeNode) -> None:
        """从 Panel 原生容器中移除 child。"""
        if isinstance(child, UIComponent) and child in list(self):  # type: ignore[attr-defined]
            self.remove(child)  # type: ignore[attr-defined]

    def _on_children_replaced(self, children: list[diyui.ScopeNode]) -> None:
        """全量替换 Panel 原生 children。"""
        self[:] = [c for c in children if isinstance(c, UIComponent)]  # type: ignore[index]

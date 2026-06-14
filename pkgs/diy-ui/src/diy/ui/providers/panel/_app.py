"""PanelApp — Panel 专属 diy.ui App。

用法：app = diypn.PanelApp()
组件方法遵循 Panel 原生子包习惯：
  app.layout.column()    # 同 pn.layout.Column()
  app.pane.markdown()    # 同 pn.pane.Markdown()
  app.widgets.button()   # 同 pn.widgets.Button()

工厂方法实现在 _factories/*.gen.py（自动生成）和 _factories/*.py（手写继承）。
"""

from __future__ import annotations

import diy.ui

from ._base import UIComponent
from ._factories import _LayoutFactory, _PaneFactory, _WidgetsFactory


class PanelApp(diy.ui.BaseApp):
    """Panel 专属 diy.ui App。

    用法：app = diypn.PanelApp()
    组件方法遵循 Panel 原生子包习惯：
      app.layout.column()    # 同 pn.layout.Column()
      app.pane.markdown()    # 同 pn.pane.Markdown()
      app.widgets.button()   # 同 pn.widgets.Button()
    """

    def __init__(self, *, config: diy.ui.ScopeConfig | None = None) -> None:
        if config is None:
            config = diy.ui.ScopeConfig(scheduler=diy.ui.ImmediateScheduler())
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
        for component in self.get_panel_roots():
            component.servable()  # type: ignore[attr-defined]

    def _find_first_real_component(self, node: diy.ui.ScopeNode) -> UIComponent | None:
        """DFS 找到第一个 UIComponent。"""
        if hasattr(node, "diy"):
            return node
        for child in node._children:
            result = self._find_first_real_component(child)
            if result is not None:
                return result
        return None

    @property
    def components(self) -> list[UIComponent]:
        """获取所有 UIComponent。"""
        result: list[UIComponent] = []
        for child in self._children:
            result.extend(self._find_all_real_components(child))
        return result

    def _find_all_real_components(self, node: diy.ui.ScopeNode) -> list[UIComponent]:
        """DFS 找到所有 UIComponent。"""
        if hasattr(node, "diy"):
            return [node]
        result: list[UIComponent] = []
        for child in node._children:
            result.extend(self._find_all_real_components(child))
        return result

    def get_panel_roots(self) -> list[UIComponent]:
        """获取所有 panel 根组件（app._children 中每个分支的第一个 UIComponent）。"""
        result: list[UIComponent] = []
        for child in self._children:
            component = self._find_first_real_component(child)
            if component is not None:
                result.append(component)
        return result

    def _sync_tree_to_panel(self, node: diy.ui.ScopeNode) -> None:
        """将 diy.ui 树同步到 Panel 原生 children。"""
        if hasattr(node, "diy") and node.diy.panel_container:
            node._on_children_replaced(node._children)
        for child in node._children:
            self._sync_tree_to_panel(child)

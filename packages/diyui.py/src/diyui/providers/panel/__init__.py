"""Panel provider — Panel 原生组件的 diyui 薄包装。

组件参数与 Panel 保持一致，导入路径对齐 Panel 习惯：
  import diyui.providers.panel as diypn
  diypn.layout.Column   # 同 pn.layout.Column
  diypn.pane.Markdown   # 同 pn.pane.Markdown
  diypn.widgets.Button  # 同 pn.widgets.Button
  diypn.PanelApp        # App 入口

diyui 在 wrapper 上附加 ScopeNode、Signal、rerun、debug、lifetime 能力。
"""

from . import layout
from . import pane
from . import widgets
from ._base import UIComponent
from ._app import PanelApp

__all__ = [
    "PanelApp",
    "UIComponent",
    "layout",
    "pane",
    "widgets",
]

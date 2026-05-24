"""Panel provider — 向后兼容入口。

从 providers.panel 包重新导出所有组件。
v0.3: 组件拆分到独立文件，此文件仅为兼容保留。
"""

from diyui.providers.panel import *  # noqa: F401, F403

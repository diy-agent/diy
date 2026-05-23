"""
diyui - A thin reactive wrapper over UI frameworks.

轻量响应式 UI 框架包装层。
"""

from diyui.base_app import BaseApp
from diyui.debug import DebugInfo, get_debug
from diyui.scheduler import ImmediateScheduler
from diyui.scope import ScopeConfig, ScopeNode
from diyui.signal import Signal

__version__ = "0.1.4"
__all__ = [
    "Signal",
    "ScopeNode",
    "ScopeConfig",
    "ImmediateScheduler",
    "BaseApp",
    "DebugInfo",
    "get_debug",
]

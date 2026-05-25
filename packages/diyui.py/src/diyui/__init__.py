"""
diyui - A thin reactive wrapper over UI frameworks.

轻量响应式 UI 框架包装层。
"""

from .base_app import BaseApp
from .debug import DebugInfo, get_debug
from .scheduler import ImmediateScheduler
from .scope import ScopeConfig, ScopeNode
from .signal import ScopeViolationError, Signal

__version__ = "0.1.4"
__all__ = [
    "Signal",
    "ScopeViolationError",
    "ScopeNode",
    "ScopeConfig",
    "ImmediateScheduler",
    "BaseApp",
    "DebugInfo",
    "get_debug",
]

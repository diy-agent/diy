"""
diy.ui - A thin reactive wrapper over UI frameworks.

轻量响应式 UI 框架包装层。
"""

from ._base_app import BaseApp
from ._debug import DebugInfo, get_debug
from ._scheduler import ImmediateScheduler
from ._scope import ScopeConfig, ScopeMode, ScopeNode
from ._signal import ScopeViolationError, Signal

__all__ = [
    "Signal",
    "ScopeViolationError",
    "ScopeNode",
    "ScopeConfig",
    "ScopeMode",
    "ImmediateScheduler",
    "BaseApp",
    "DebugInfo",
    "get_debug",
]

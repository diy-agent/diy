"""
xxui - A thin reactive wrapper over UI frameworks.
"""

from xxui.base_app import BaseApp
from xxui.debug import DebugInfo, get_debug
from xxui.scheduler import ImmediateScheduler
from xxui.scope import ScopeConfig, ScopeNode
from xxui.signal import Signal

__version__ = "0.1.0"
__all__ = [
    "Signal",
    "ScopeNode",
    "ScopeConfig",
    "ImmediateScheduler",
    "BaseApp",
    "DebugInfo",
    "get_debug",
]

"""
xxui - A thin reactive wrapper over UI frameworks.
"""

from xxui.signal import Signal
from xxui.scope import ScopeNode, ScopeConfig
from xxui.scheduler import ImmediateScheduler
from xxui.base_app import BaseApp
from xxui.debug import DebugInfo, get_debug

__version__ = "0.1.0"
__all__ = ["Signal", "ScopeNode", "ScopeConfig", "ImmediateScheduler", "BaseApp", "DebugInfo"]

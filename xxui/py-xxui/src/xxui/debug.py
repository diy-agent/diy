"""Debug — xxui scope 级别的调试/日志/通知基础设施。

v0.1 最小实现：错误捕获、rerun 计数、dev/prod 区分。
数据模型预留扩展：日志策略、通知渠道等。
"""

from __future__ import annotations

import traceback
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xxui.scope import ScopeNode


class DebugInfo:
    """ScopeNode 的调试信息。

    通过 get_debug(node) 获取，自动向上追溯。
    """

    def __init__(self, node: ScopeNode) -> None:
        self._node = node
        self.rerun_count: int = 0
        self.last_error: str | None = None
        self._has_error: bool = False

    @property
    def mode(self) -> str:
        m = self._node.get_config("mode")
        return m if m else "prod"

    @property
    def has_error(self) -> bool:
        return self._has_error

    def record_error(self, exc: Exception) -> None:
        """记录 cell 执行错误。"""
        self._has_error = True
        self.last_error = "".join(
            traceback.format_exception_only(type(exc), exc)
        ).strip()

    def record_rerun(self) -> None:
        self.rerun_count += 1


_debug_cache: dict[int, DebugInfo] = {}


def get_debug(node: ScopeNode) -> DebugInfo:
    """获取或创建 node 的 DebugInfo。"""
    key = id(node)
    if key not in _debug_cache:
        _debug_cache[key] = DebugInfo(node)
    return _debug_cache[key]

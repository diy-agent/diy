"""BaseApp — xxui App 基类。

各 provider App（Panel、marimo）继承 BaseApp。
提供 with context 管理、app.signal()、上下文栈。
"""
from __future__ import annotations
from typing import TypeVar
from xxui.signal import Signal
from xxui.scope import ScopeNode

T = TypeVar("T")


class BaseApp(ScopeNode):
    """App 基类，也是 ScopeNode 树的根节点。

    _context_stack 顶部是当前活跃的 ScopeNode。
    所有组件创建和 signal 挂载都落到 _current。
    """

    def __init__(self) -> None:
        super().__init__()
        self._context_stack: list[ScopeNode] = [self]

    # ── context ────────────────────────────────

    @property
    def _current(self) -> ScopeNode:
        return self._context_stack[-1]

    def _push_context(self, node: ScopeNode) -> None:
        self._context_stack.append(node)

    def _pop_context(self) -> None:
        if len(self._context_stack) <= 1:
            raise IndexError("不能 pop 最后一个 context（app 本身）")
        self._context_stack.pop()

    def _add_to_current(self, child: ScopeNode) -> None:
        """将 child 添加到当前 context 节点。"""
        child._app = self
        self._current._add_child(child)

    # ── signal ─────────────────────────────────

    def signal(self, value: T) -> Signal[T]:
        """创建 Signal 并挂载到当前 ScopeNode。"""
        sig = Signal[T](value)
        self._current._mount_signal(sig)
        return sig

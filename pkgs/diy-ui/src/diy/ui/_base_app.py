"""BaseApp — diy.ui App 基类。

各 provider App（Panel 等）继承 BaseApp。
提供 with context 管理、app.signal()、上下文栈。

Phase 2：context stack 存储 ScopeProxy 而非 ScopeNode。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._signal import Signal

from contextvars import ContextVar, Token

from ._scope import ScopeNode, ScopeProxy


class BaseApp(ScopeNode):
    """App 基类，也是 ScopeNode 树的根节点。

    使用 ContextVar 管理上下文栈，确保异步安全。
    栈顶是当前活跃的 ScopeProxy。所有组件创建和 signal 挂载都落到 _current。
    """

    def __init__(self) -> None:
        super().__init__()
        self._context_stack_var: ContextVar[tuple[ScopeProxy, ...]] = ContextVar(
            f"diyui_context_stack_{id(self)}", default=()
        )
        self._context_stack_var.set((self.diy,))

    # ── context ────────────────────────────────

    @property
    def _current(self) -> ScopeProxy:
        stack = self._context_stack_var.get()
        if not stack:
            return self.diy
        return stack[-1]

    def _push_context(self, proxy: ScopeProxy) -> Token[tuple[ScopeProxy, ...]]:
        stack = self._context_stack_var.get()
        if not stack:
            stack = (self.diy,)
        return self._context_stack_var.set(stack + (proxy,))

    def _pop_context(self, token: Token[tuple[ScopeProxy, ...]] | None = None) -> None:
        if token is not None:
            self._context_stack_var.reset(token)
        else:
            stack = self._context_stack_var.get()
            if len(stack) <= 1:
                raise IndexError("不能 pop 最后一个 context（app 本身）")
            self._context_stack_var.set(stack[:-1])

    def _add_to_current(self, child: ScopeProxy) -> None:
        """将 child 添加到当前 context 节点。

        若当前节点的 auto_mount_child 为 False，仅设置 _app，不挂载。
        """
        child._app = self
        if self._current._lookup_auto_mount_child:
            self._current._add_child(child)

    # ── signal ─────────────────────────────────

    def signal(self, value):
        """创建 Signal 并挂载到当前 scope 节点。"""
        return self._current.create_signal(value)
